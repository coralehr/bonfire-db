/**
 * vd_* table planning and DDL/DML execution over postgres.js tagged-template
 * FRAGMENTS only: identifiers go through `sql(identifier)`, values bind as
 * parameters, jsonb binds via `sql.json` (BP-015), and `.unsafe` is never
 * used (BP-020). Every created table gets the verbatim BF-02 fail-closed RLS
 * template explicitly — the migration 0004 event trigger is belt-and-braces,
 * not the primary control.
 */
import type { JsonValue, Result } from "@bonfire/core";
import { err, ok } from "@bonfire/core";
import type { Fragment, ISql } from "postgres";

/** Any postgres.js handle (pool or transaction) — the shared query surface. */
export type SqlHandle = ISql;

import type { Row } from "../engine/selection.js";
import type { ProjectionError } from "../errors.js";
import type { MaterializableView } from "../view-definition.js";
import { viewColumns } from "../view-definition.js";
import type { PgColumnType } from "./type-map.js";
import { pgColumnType } from "./type-map.js";

export interface PlannedColumn {
  readonly name: string;
  readonly pgType: PgColumnType;
}

export interface TablePlan {
  readonly table: string;
  readonly keyColumn: string;
  readonly columns: readonly PlannedColumn[];
}

/** Pure: derive the vd_* table shape from a materializable view. */
export function planTable(view: MaterializableView): Result<TablePlan, ProjectionError> {
  const columns = viewColumns(view.view);
  if (!columns.ok) {
    return err({ code: "PROJECTION_VIEW_INVALID", message: columns.error.message });
  }
  return ok({
    table: `vd_${view.name}`,
    keyColumn: view.keyColumn,
    columns: columns.data.map((column) => ({
      name: column.name,
      pgType: pgColumnType(column.type, column.collection)
    }))
  });
}

function typeFragment(sql: SqlHandle, pgType: PgColumnType): Fragment {
  switch (pgType) {
    case "boolean":
      return sql`boolean`;
    case "integer":
      return sql`integer`;
    case "text":
      return sql`text`;
    case "jsonb":
      return sql`jsonb`;
  }
}

function joinFragments(sql: SqlHandle, fragments: readonly Fragment[]): Fragment {
  return fragments.reduce((acc, fragment) => sql`${acc}, ${fragment}`);
}

/**
 * Drop + create one vd_* table (idempotent rebuild path, owner connection):
 * system columns, tenant-scoped primary key — (practice_id, key, row_index),
 * so key equality never becomes a cross-tenant existence oracle — and the
 * explicit ENABLE + FORCE RLS + tenant-isolation policy template.
 */
export async function createProjectionTable(sql: SqlHandle, plan: TablePlan): Promise<void> {
  const columnDefs = plan.columns.map(
    (column) => sql`${sql(column.name)} ${typeFragment(sql, column.pgType)}`
  );
  await sql`drop table if exists ${sql(plan.table)}`;
  await sql`create table ${sql(plan.table)} (
    practice_id uuid not null,
    row_index bigint not null,
    version_id bigint not null,
    last_updated timestamptz not null,
    ${joinFragments(sql, columnDefs)},
    primary key (practice_id, ${sql(plan.keyColumn)}, row_index)
  )`;
  await sql`alter table ${sql(plan.table)} enable row level security`;
  await sql`alter table ${sql(plan.table)} force row level security`;
  const policy = `${plan.table}_tenant_isolation`;
  await sql`drop policy if exists ${sql(policy)} on ${sql(plan.table)}`;
  await sql`create policy ${sql(policy)} on ${sql(plan.table)}
    as permissive for all to "bonfire_app"
    using ("practice_id" = (select safe_uuid(current_setting('app.current_practice_id', true))))
    with check ("practice_id" = (select safe_uuid(current_setting('app.current_practice_id', true))))`;
}

function valueFragment(sql: SqlHandle, pgType: PgColumnType, value: JsonValue): Fragment {
  if (value === null) return sql`null`;
  if (pgType === "jsonb" || typeof value === "object") return sql`${sql.json(value)}`;
  return sql`${value}`;
}

/** Metadata copied from the canonical fhir_resources row — never invented. */
export interface ProjectionRowMeta {
  readonly practice: Fragment;
  readonly rowIndex: number;
  readonly versionId: string;
  /** timestamptz rendered as text so microseconds survive the round-trip. */
  readonly lastUpdated: string;
}

/** Insert ONE projected row; shared verbatim by rebuild and upsert paths. */
export async function insertProjectionRow(
  sql: SqlHandle,
  plan: TablePlan,
  meta: ProjectionRowMeta,
  row: Row
): Promise<void> {
  const names = plan.columns.map((column) => sql`${sql(column.name)}`);
  const values = plan.columns.map((column) =>
    valueFragment(sql, column.pgType, row[column.name] ?? null)
  );
  await sql`insert into ${sql(plan.table)} (
    practice_id, row_index, version_id, last_updated, ${joinFragments(sql, names)}
  ) values (
    ${meta.practice}, ${meta.rowIndex}, ${meta.versionId}, ${meta.lastUpdated},
    ${joinFragments(sql, values)}
  )`;
}
