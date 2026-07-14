/**
 * In-transaction projection upsert — the ONE write path hook. Runs ENTIRELY
 * on the caller's tenant transaction handle (no new pool, no nested begin),
 * so canonical write + projection + spidx commit or roll back together.
 * Everything is computed BEFORE the first DML statement: an expected failure
 * returns a typed err with zero writes issued, and any DML failure throws so
 * `withTenant` rolls the whole transaction back (no partial write).
 */
import type { JsonObject, Result, TenantSql } from "@bonfire/core";
import { err, fhirContentSchema, ok } from "@bonfire/core";
import { z } from "zod";
import { evaluateView } from "../engine/evaluate.js";
import type { Row } from "../engine/selection.js";
import type { ProjectionError } from "../errors.js";
import { extractSearchParams } from "../spidx.js";
import type { MaterializableView } from "../view-definition.js";
import type { TablePlan } from "./ddl.js";
import { insertProjectionRow, planTable } from "./ddl.js";
import { insertSpidxRows, practiceFromGuc } from "./spidx-write.js";

const resourceIdSchema = z.uuid();

const currentRowSchema = z.object({
  type: z.string().min(1),
  version_id: z.string().min(1),
  last_updated: z.string().min(1),
  content: fhirContentSchema
});

export interface UpsertSummary {
  readonly vdRows: number;
  readonly spidxRows: number;
}

interface PlannedRows {
  readonly plan: TablePlan;
  readonly rows: readonly Row[];
}

function projectAll(
  views: readonly MaterializableView[],
  type: string,
  content: JsonObject
): Result<PlannedRows[], ProjectionError> {
  const projected: PlannedRows[] = [];
  for (const view of views) {
    if (view.view.resource !== type) continue;
    const plan = planTable(view);
    if (!plan.ok) return plan;
    const rows = evaluateView(view.view, content);
    if (!rows.ok) {
      return err({
        code: "PROJECTION_VIEW_INVALID",
        message: `view '${view.name}' failed: ${rows.error.message}`
      });
    }
    projected.push({ plan: plan.data, rows: rows.data });
  }
  return ok(projected);
}

type CurrentRow = z.infer<typeof currentRowSchema>;

/**
 * Fetch + boundary-validate the canonical row inside the tenant tx. Fails
 * closed on invisibility AND on key divergence: vd rows are keyed and DELETEd
 * by the projected getResourceKey() (= content.id) while the upsert is
 * addressed by fhir_resources.id — if the two diverge, stale rows under the
 * old key would survive every upsert and drift from a rebuild.
 */
async function fetchCanonicalRow(
  sql: TenantSql,
  resourceId: string
): Promise<Result<CurrentRow, ProjectionError>> {
  const currentRows = await sql`
    select type, version_id::text as version_id, last_updated::text as last_updated, content
    from fhir_resources
    where id = ${resourceId}`;
  const current = currentRowSchema.safeParse(currentRows[0]);
  if (!current.success) {
    return err({
      code: "PROJECTION_RESOURCE_NOT_FOUND",
      message: "resource is not visible in this tenant transaction"
    });
  }
  if (current.data.content.id !== resourceId) {
    return err({
      code: "PROJECTION_KEY_MISMATCH",
      message: "canonical content.id does not equal the fhir_resources row id"
    });
  }
  return ok(current.data);
}

/**
 * Recompute the vd_* and spidx rows for ONE resource inside the caller's
 * tenant transaction (DELETE + INSERT keyed on the resource id; RLS scopes
 * both). Reads version_id/last_updated from the canonical row in-tx — a
 * missing resource is a typed error, never an invented projection.
 *
 * CALLER CONTRACT (the deferred write-path wiring must honor this): a typed
 * err return means ZERO projection DML was issued — the caller must treat it
 * as a failure of the whole canonical write (abort/throw so the transaction
 * rolls back), or the canonical row commits with NO projection rows and the
 * read surface goes stale until the next offline rebuild.
 */
export async function upsertProjection(
  sql: TenantSql,
  resourceId: string,
  views: readonly MaterializableView[]
): Promise<Result<UpsertSummary, ProjectionError>> {
  const parsedId = resourceIdSchema.safeParse(resourceId);
  if (!parsedId.success) {
    return err({ code: "PROJECTION_INVALID_INPUT", message: "resourceId must be a UUID" });
  }
  const fetched = await fetchCanonicalRow(sql, parsedId.data);
  if (!fetched.ok) return fetched;
  const current = { data: fetched.data };
  const projected = projectAll(views, current.data.type, current.data.content);
  if (!projected.ok) return projected;
  const spidxRows = extractSearchParams(current.data.content);
  // All projections computed — only now does DML start (throws roll back).
  const practice = practiceFromGuc(sql);
  let vdCount = 0;
  for (const entry of projected.data) {
    await sql`delete from ${sql(entry.plan.table)}
      where ${sql(entry.plan.keyColumn)} = ${parsedId.data}`;
    for (const [rowIndex, row] of entry.rows.entries()) {
      await insertProjectionRow(
        sql,
        entry.plan,
        {
          practice,
          rowIndex,
          versionId: current.data.version_id,
          lastUpdated: current.data.last_updated
        },
        row
      );
      vdCount += 1;
    }
  }
  await sql`delete from spidx where resource_id = ${parsedId.data}`;
  await insertSpidxRows(sql, practice, parsedId.data, spidxRows);
  return ok({ vdRows: vdCount, spidxRows: spidxRows.length });
}
