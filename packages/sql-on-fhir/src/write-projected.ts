/**
 * The ONE write path: canonical scribe write + vd_* + spidx + search projection
 * upsert on the SAME tenant transaction handle, committing or rolling back
 * together.
 * This is the composition the BF-04 contract deferred ("usable inside the
 * canonical write transaction") — core cannot import this package (it would
 * be a dependency cycle), so the composition lives here, one level above.
 *
 * Fail-closed asymmetry, load-bearing: a typed err from writeScribeResource
 * is safe to RETURN (its atomicity contract guarantees zero DML on err), but
 * a projection err after the canonical insert must THROW — withTenant only
 * rolls back on throw, and returning it would commit the canonical row with
 * no projection rows (the stale-read drift upsertProjection's caller contract
 * forbids).
 */
import type {
  BonfireError,
  IndexErrorCode,
  IndexSummary,
  Result,
  TenantSql,
  WriteError,
  WriteResult
} from "@bonfire/core";
import { indexResourceTx, ok, writeScribeResource } from "@bonfire/core";
import type { ProjectionError, ViewError } from "./errors.js";
import type { UpsertSummary } from "./materialize/upsert.js";
import { upsertProjection } from "./materialize/upsert.js";
import { loadScribeViews } from "./scribe-views.js";
import type { MaterializableView } from "./view-definition.js";

export interface ProjectedWriteResult extends WriteResult {
  readonly projection: UpsertSummary;
  readonly search: IndexSummary;
}

export type ProjectedWriteError =
  | WriteError
  | ProjectionError
  | ViewError
  | BonfireError<IndexErrorCode>;

export type SearchProjector = (
  sql: TenantSql,
  resourceId: string
) => Promise<Result<IndexSummary, BonfireError<IndexErrorCode>>>;

/**
 * Write a scribe resource AND its projections inside the caller's withTenant
 * transaction. `views` defaults to the staged scribe ViewDefinitions; pass an
 * explicit list to scope or extend. `projectSearch` is a trusted composition
 * seam used to test a failure after vd/spidx DML without changing production
 * behavior.
 */
export async function writeScribeResourceProjected(
  sql: TenantSql,
  input: unknown,
  views?: readonly MaterializableView[],
  projectSearch: SearchProjector = indexResourceTx
): Promise<Result<ProjectedWriteResult, ProjectedWriteError>> {
  let resolved: readonly MaterializableView[];
  if (views === undefined) {
    const loaded = loadScribeViews();
    if (!loaded.ok) return loaded;
    resolved = loaded.data;
  } else {
    resolved = views;
  }
  const written = await writeScribeResource(sql, input);
  if (!written.ok) return written;
  const projected = await upsertProjection(sql, written.data.record.id, resolved);
  if (!projected.ok) {
    // Canonical DML already ran — only a throw aborts the transaction.
    throw new Error(
      `projection failed after canonical write: [${projected.error.code}] ${projected.error.message}`
    );
  }
  const indexed = await projectSearch(sql, written.data.record.id);
  if (!indexed.ok) {
    throw new Error(
      `search projection failed after canonical write: [${indexed.error.code}] ${indexed.error.message}`
    );
  }
  return ok({ ...written.data, projection: projected.data, search: indexed.data });
}
