/**
 * Deterministic ordered table dump -> sha256, the byte-identity oracle for
 * "drop + rebuild from canonical FHIR produces identical rows". Transport is
 * an ordered SELECT of `to_jsonb(row)` canonicalized via the same
 * canonical-JSON serializer the FHIR store uses (the sanctioned fallback in
 * the BF-04 plan; COPY TO STDOUT adds a stream dependency without changing
 * the invariant — recorded in the ADR).
 */
import { createHash } from "node:crypto";
import type { JsonValue, Result } from "@bonfire/core";
import { canonicalizeJson, err, jsonValueSchema, ok } from "@bonfire/core";
import type { ProjectionError } from "./errors.js";
import type { SqlHandle } from "./materialize/ddl.js";

export interface DumpOptions {
  /** Columns stripped before hashing (e.g. spidx's synthetic identity). */
  readonly excludeColumns?: readonly string[];
}

/** Hash every row of `table` in a deterministic total order. */
export async function orderedDumpHash(
  sql: SqlHandle,
  table: string,
  options: DumpOptions = {}
): Promise<Result<string, ProjectionError>> {
  let expression = sql`to_jsonb(t)`;
  for (const column of options.excludeColumns ?? []) {
    expression = sql`${expression} - ${column}::text`;
  }
  const rows = await sql`
    select ${expression} as row
    from ${sql(table)} t
    order by 1`;
  const values: JsonValue[] = [];
  for (const raw of rows) {
    const parsed = jsonValueSchema.safeParse(raw.row);
    if (!parsed.success) {
      return err({
        code: "PROJECTION_ROW_INVALID",
        message: `${table} dump row is not canonical JSON`
      });
    }
    values.push(parsed.data);
  }
  const canonical = canonicalizeJson(values);
  return ok(createHash("sha256").update(canonical, "utf8").digest("hex"));
}
