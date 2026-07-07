/**
 * `searchClinical` — the hybrid cited-search read primitive. Runs inside the
 * caller's `withTenant` transaction (mirrors appendAuditRowTx / upsertProjection):
 * it parses the untrusted request, derives the ABAC scope BEFORE any retrieval,
 * runs the fused RRF query ONLY over allowed types, UNCONDITIONALLY appends
 * exactly one audit row on every return path (deny / zero-result / normal), and
 * stamps every hit's citation with that audit row_hash. The response is Zod-parsed
 * at the boundary (acceptance #1). Malformed input and a missing tenant context
 * are typed `err` values; a DB fault throws so withTenant rolls the tx back.
 */

import { z } from "zod";
import { appendAuditRowTx } from "../audit/audit-log.js";
import type { TenantSql } from "../db/tenant.js";
import type { BonfireError, Result } from "../result.js";
import { err, ok } from "../result.js";
import { type DerivedScope, deriveScope } from "./derive-scope.js";
import { devEmbedder, isZeroEmbedding } from "./dev-embedder.js";
import { type FusedHit, fuseSearch } from "./fuse.js";
import { buildSearchReceipt } from "./receipt.js";
import {
  DEFAULT_TOP_N,
  EMBEDDING_DIM,
  type SearchConfig,
  type SearchHit,
  type SearchResponse,
  searchInputSchema,
  searchResponseSchema
} from "./schemas.js";

export type SearchErrorCode = "SEARCH_INVALID_INPUT" | "SEARCH_NO_TENANT";

const gucRowSchema = z.object({ practice_id: z.uuid() });

function defaultNow(): string {
  return new Date().toISOString();
}

/** The bound tenant id, read from the transaction GUC (the single source for the receipt). */
async function boundPracticeId(sql: TenantSql): Promise<string | null> {
  const rows = await sql`
    select (select safe_uuid(current_setting('app.current_practice_id', true)))::text as practice_id`;
  const parsed = gucRowSchema.safeParse(rows[0]);
  return parsed.success ? parsed.data.practice_id : null;
}

function scopeReason(scope: DerivedScope): string {
  return scope.allowed.length > 0
    ? `search: ${String(scope.allowed.length)} type(s) in scope`
    : "search: all requested types denied";
}

/** Embed the query and run the fused arms; a zero-norm query goes lexical-only. */
async function retrieve(
  sql: TenantSql,
  query: string,
  allowed: readonly string[],
  topN: number,
  config: SearchConfig
): Promise<readonly FusedHit[]> {
  const embedder = config.embedder ?? devEmbedder;
  if (embedder.dimension !== EMBEDDING_DIM) throw new Error("embedder dimension must be 384");
  const vector = await embedder.embed(query);
  if (vector.length !== EMBEDDING_DIM) throw new Error("embedding dimension mismatch");
  const qvec = isZeroEmbedding(vector) ? null : `[${vector.join(",")}]`;
  // model_id scopes both arms + the join to THIS embedder's space, so a non-default
  // provider is never silently zeroed against dev-hash-v1 rows.
  return fuseSearch(sql, { query, qvec, allowed, modelId: embedder.modelId, topN });
}

function toSearchHit(hit: FusedHit, rowHash: string): SearchHit {
  return {
    resourceType: hit.resourceType,
    resourceId: hit.resourceId,
    score: hit.score,
    citation: { resourceId: hit.resourceId, path: hit.sourcePath, rowHash },
    freshness: { lastUpdated: hit.lastUpdated, versionId: hit.versionId }
  };
}

export async function searchClinical(
  sql: TenantSql,
  input: unknown,
  config: SearchConfig = {}
): Promise<Result<SearchResponse, BonfireError<SearchErrorCode>>> {
  const parsed = searchInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({ code: "SEARCH_INVALID_INPUT", message: "malformed search request" });
  }
  const req = parsed.data;
  const now = config.now ?? defaultNow;
  const practiceId = await boundPracticeId(sql);
  if (practiceId === null) {
    return err({ code: "SEARCH_NO_TENANT", message: "no bound practice context" });
  }
  const scope = deriveScope(req.subject, req.purposeOfUse, practiceId, now);
  const topN = req.topN ?? DEFAULT_TOP_N;
  // Scope-before-retrieve: no allowed type => ZERO fusion SQL runs.
  const rawHits =
    scope.allowed.length === 0 ? [] : await retrieve(sql, req.query, scope.allowed, topN, config);
  const receipt = buildSearchReceipt({
    decision: scope.allowed.length > 0 ? "allow" : "deny",
    actorId: req.subject.id,
    practiceId,
    purposeOfUse: req.purposeOfUse,
    reason: scopeReason(scope),
    timestamp: now()
  });
  // Audit-on-read: exactly one append on EVERY path, before results are returned.
  const { auditRowHash } = await appendAuditRowTx(sql, receipt);
  const decorated = rawHits.map((hit) => toSearchHit(hit, auditRowHash));
  const results =
    config.reranker === undefined ? decorated : [...(await config.reranker.rerank(decorated))];
  const response = {
    results,
    excludedByPolicy: { count: scope.excluded.length, resourceTypes: [...scope.excluded] },
    policyReceipt: receipt,
    auditEventId: auditRowHash
  };
  return ok(searchResponseSchema.parse(response));
}
