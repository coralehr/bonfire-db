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
  FhirResourceRecord,
  FhirStoreErrorCode,
  IndexErrorCode,
  IndexSummary,
  ReferenceProjectionErrorCode,
  ReferenceProjectionSummary,
  Result,
  TenantSql,
  UpdateFhirResourceInput,
  WriteError,
  WriteResult
} from "@bonfire/core";
import {
  indexResourceTx,
  ok,
  replaceReferenceEdgesTx,
  updateFhirResourceTx,
  writeScribeResource
} from "@bonfire/core";
import type { ProjectionError, ViewError } from "./errors.js";
import type { UpsertSummary } from "./materialize/upsert.js";
import { upsertProjection } from "./materialize/upsert.js";
import { loadScribeViews } from "./scribe-views.js";
import type { MaterializableView } from "./view-definition.js";

export interface ProjectedWriteResult extends WriteResult {
  readonly projection: UpsertSummary;
  readonly references: ReferenceProjectionSummary;
  readonly search: IndexSummary;
}

export interface ProjectedUpdateResult {
  readonly record: FhirResourceRecord;
  readonly projection: UpsertSummary;
  readonly references: ReferenceProjectionSummary;
  readonly search: IndexSummary;
}

export type ProjectedWriteError =
  | WriteError
  | ProjectionError
  | ViewError
  | BonfireError<FhirStoreErrorCode>
  | BonfireError<ReferenceProjectionErrorCode>
  | BonfireError<IndexErrorCode>;

export type SearchProjector = (
  sql: TenantSql,
  resourceId: string
) => Promise<Result<IndexSummary, BonfireError<IndexErrorCode>>>;

export type ReferenceProjector = (
  sql: TenantSql,
  resourceId: string
) => Promise<Result<ReferenceProjectionSummary, BonfireError<ReferenceProjectionErrorCode>>>;

function resolveViews(
  views: readonly MaterializableView[] | undefined
): Result<readonly MaterializableView[], ViewError> {
  return views === undefined ? loadScribeViews() : ok(views);
}

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
  projectSearch: SearchProjector = indexResourceTx,
  projectReferences: ReferenceProjector = replaceReferenceEdgesTx
): Promise<Result<ProjectedWriteResult, ProjectedWriteError>> {
  const resolved = resolveViews(views);
  if (!resolved.ok) return resolved;
  const written = await writeScribeResource(sql, input);
  if (!written.ok) return written;
  const projected = await upsertProjection(sql, written.data.record.id, resolved.data);
  if (!projected.ok) {
    // Canonical DML already ran — only a throw aborts the transaction.
    throw new Error(
      `projection failed after canonical write: [${projected.error.code}] ${projected.error.message}`
    );
  }
  const referenced = await projectReferences(sql, written.data.record.id);
  if (!referenced.ok) {
    throw new Error(
      `reference projection failed after canonical write: [${referenced.error.code}] ${referenced.error.message}`
    );
  }
  const indexed = await projectSearch(sql, written.data.record.id);
  if (!indexed.ok) {
    throw new Error(
      `search projection failed after canonical write: [${indexed.error.code}] ${indexed.error.message}`
    );
  }
  return ok({
    ...written.data,
    projection: projected.data,
    references: referenced.data,
    search: indexed.data
  });
}

/**
 * Update canonical FHIR and replace every derived projection in the same
 * tenant transaction. Any post-canonical projection failure throws so the
 * version append and every read model roll back together.
 */
export async function updateFhirResourceProjected(
  sql: TenantSql,
  input: UpdateFhirResourceInput,
  views?: readonly MaterializableView[],
  projectSearch: SearchProjector = indexResourceTx,
  projectReferences: ReferenceProjector = replaceReferenceEdgesTx
): Promise<Result<ProjectedUpdateResult, ProjectedWriteError>> {
  const resolved = resolveViews(views);
  if (!resolved.ok) return resolved;
  const updated = await updateFhirResourceTx(sql, input);
  if (!updated.ok) return updated;
  const projected = await upsertProjection(sql, updated.data.id, resolved.data);
  if (!projected.ok) {
    throw new Error(
      `projection failed after canonical update: [${projected.error.code}] ${projected.error.message}`
    );
  }
  const referenced = await projectReferences(sql, updated.data.id);
  if (!referenced.ok) {
    throw new Error(
      `reference projection failed after canonical update: [${referenced.error.code}] ${referenced.error.message}`
    );
  }
  const indexed = await projectSearch(sql, updated.data.id);
  if (!indexed.ok) {
    throw new Error(
      `search projection failed after canonical update: [${indexed.error.code}] ${indexed.error.message}`
    );
  }
  return ok({
    record: updated.data,
    projection: projected.data,
    references: referenced.data,
    search: indexed.data
  });
}
