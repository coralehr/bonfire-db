/**
 * Offline drop+rebuild of every vd_* projection and the spidx index from
 * canonical fhir_resources — the proof that the read surface is a pure
 * function of canonical FHIR. Runs on an OWNER connection passed in by the
 * caller (scripts/sql-on-fhir/rebuild.ts); projections are never DDL'd on a
 * request path. All projections are recomputed in memory FIRST (any typed
 * evaluation error aborts before a single write), then written in ONE
 * transaction.
 */
import type { JsonObject, Result } from "@bonfire/core";
import { err, jsonValueSchema, ok } from "@bonfire/core";
import type { Sql } from "postgres";
import { z } from "zod";
import { evaluateView } from "../engine/evaluate.js";
import type { Row } from "../engine/selection.js";
import type { ProjectionError } from "../errors.js";
import type { SpidxRow } from "../spidx.js";
import { extractSearchParams } from "../spidx.js";
import type { MaterializableView } from "../view-definition.js";
import type { SqlHandle, TablePlan } from "./ddl.js";
import { createProjectionTable, insertProjectionRow, planTable } from "./ddl.js";
import { insertSpidxRows } from "./spidx-write.js";

const resourceRowSchema = z.object({
  id: z.uuid(),
  type: z.string().min(1),
  practice_id: z.uuid(),
  version_id: z.string().min(1),
  last_updated: z.string().min(1),
  content: z.record(z.string(), jsonValueSchema)
});

interface PlannedProjection {
  readonly plan: TablePlan;
  readonly view: MaterializableView;
}

interface ComputedResource {
  readonly id: string;
  readonly practiceId: string;
  readonly versionId: string;
  readonly lastUpdated: string;
  readonly vdRows: readonly { readonly table: string; readonly rows: readonly Row[] }[];
  readonly spidxRows: readonly SpidxRow[];
}

export interface RebuildSummary {
  readonly resources: number;
  readonly spidxRows: number;
  readonly tableRows: Readonly<Record<string, number>>;
}

function computeResource(
  raw: unknown,
  projections: readonly PlannedProjection[]
): Result<ComputedResource, ProjectionError> {
  const parsed = resourceRowSchema.safeParse(raw);
  if (!parsed.success) {
    return err({
      code: "PROJECTION_ROW_INVALID",
      message: "fhir_resources row failed boundary validation"
    });
  }
  // Same policy as upsertProjection: vd rows are keyed by the projected
  // getResourceKey() (= content.id), so a canonical row whose content.id
  // diverges from its row id must fail the rebuild loudly — silently
  // projecting it would drift the two writers apart (and hide corruption).
  if (parsed.data.content.id !== parsed.data.id) {
    return err({
      code: "PROJECTION_KEY_MISMATCH",
      message: `canonical content.id diverges from row id ${parsed.data.id}`
    });
  }
  const content: JsonObject = parsed.data.content;
  const vdRows: { table: string; rows: readonly Row[] }[] = [];
  for (const projection of projections) {
    if (projection.view.view.resource !== parsed.data.type) continue;
    const rows = evaluateView(projection.view.view, content);
    if (!rows.ok) {
      return err({
        code: "PROJECTION_VIEW_INVALID",
        message: `view '${projection.view.name}' failed on ${parsed.data.id}: ${rows.error.message}`
      });
    }
    vdRows.push({ table: projection.plan.table, rows: rows.data });
  }
  return ok({
    id: parsed.data.id,
    practiceId: parsed.data.practice_id,
    versionId: parsed.data.version_id,
    lastUpdated: parsed.data.last_updated,
    vdRows,
    spidxRows: extractSearchParams(content)
  });
}

function planProjections(
  views: readonly MaterializableView[]
): Result<PlannedProjection[], ProjectionError> {
  const projections: PlannedProjection[] = [];
  for (const view of views) {
    const plan = planTable(view);
    if (!plan.ok) return plan;
    projections.push({ plan: plan.data, view });
  }
  return ok(projections);
}

async function writeAll(
  sql: SqlHandle,
  projections: readonly PlannedProjection[],
  computed: readonly ComputedResource[]
): Promise<RebuildSummary> {
  const tableRows: Record<string, number> = {};
  let spidxCount = 0;
  for (const projection of projections) {
    await createProjectionTable(sql, projection.plan);
    tableRows[projection.plan.table] = 0;
  }
  await sql`truncate spidx restart identity`;
  const planByTable = new Map(projections.map((p) => [p.plan.table, p.plan]));
  for (const resource of computed) {
    const practice = sql`${resource.practiceId}::uuid`;
    for (const entry of resource.vdRows) {
      const plan = planByTable.get(entry.table);
      if (plan === undefined) continue;
      for (const [rowIndex, row] of entry.rows.entries()) {
        await insertProjectionRow(
          sql,
          plan,
          {
            practice,
            rowIndex,
            versionId: resource.versionId,
            lastUpdated: resource.lastUpdated
          },
          row
        );
        tableRows[entry.table] = (tableRows[entry.table] ?? 0) + 1;
      }
    }
    await insertSpidxRows(sql, practice, resource.id, resource.spidxRows);
    spidxCount += resource.spidxRows.length;
  }
  return { resources: computed.length, spidxRows: spidxCount, tableRows };
}

/**
 * Rebuild every projection from canonical FHIR. `ownerSql` MUST be the
 * migration-owner connection (DDL + full-corpus scan legitimately bypass RLS
 * here and nowhere else).
 */
export async function rebuildProjections(
  ownerSql: Sql,
  views: readonly MaterializableView[]
): Promise<Result<RebuildSummary, ProjectionError>> {
  const projections = planProjections(views);
  if (!projections.ok) return projections;
  let summary: RebuildSummary | undefined;
  let computeError: ProjectionError | undefined;
  try {
    // Corpus scan and drop/create/refill share ONE transaction: the single
    // SELECT is one snapshot, so no canonical write can slip between "read
    // the corpus" and "write the projections" (the read-then-begin TOCTOU
    // window). A compute error throws to roll back (only reads happened).
    await ownerSql.begin(async (sql) => {
      const rawRows = await sql`
        select id, type, practice_id, version_id::text as version_id,
               last_updated::text as last_updated, content
        from fhir_resources
        order by id`;
      const computed: ComputedResource[] = [];
      for (const raw of rawRows) {
        const resource = computeResource(raw, projections.data);
        if (!resource.ok) {
          computeError = resource.error;
          throw new Error(resource.error.code);
        }
        computed.push(resource.data);
      }
      summary = await writeAll(sql, projections.data, computed);
    });
  } catch (cause) {
    if (computeError !== undefined) return err(computeError);
    throw cause;
  }
  if (summary === undefined) {
    return err({
      code: "PROJECTION_ROW_INVALID",
      message: "rebuild transaction yielded no summary"
    });
  }
  return ok(summary);
}
