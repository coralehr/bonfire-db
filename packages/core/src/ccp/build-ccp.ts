/**
 * `buildCcp` — the agent's default read surface. Runs inside the caller's
 * `withTenant` transaction and turns one policy-scoped BF-06 SearchResponse
 * into a compact, span-cited document. Order of operations:
 *
 *   1. Zod-parse the untrusted input; a pre-parse failure appends NO audit row
 *      (nothing was read, nothing attributable — the searchClinical precedent).
 *   2. Read the bound practice from the tenant GUC — the ONLY practice id used.
 *   3. Cross-check the response receipt (tenant, purpose, actor, decision) —
 *      a mismatch is a laundering attempt and denies BEFORE any read.
 *   4. THE single canonical read: one id-set query against fhir_resources,
 *      bounded by FORCE RLS — never a practice_id predicate, and no other
 *      fhir_resources/search_doc query exists anywhere in ccp/**.
 *   5. Fail closed on any unresolved id (count only), any type confusion, and
 *      any resolved type outside the re-derived ABAC scope.
 *   6. Extract spans via the declared leaf-path table, order groups U-shape,
 *      serialize, digest, and append EXACTLY ONE audit row — unconditionally
 *      on every post-parse path (T8) — whose row_hash every span then carries.
 */
import { z } from "zod";
import type { Decision } from "../abac/types.js";
import { appendAuditRowTx } from "../audit/audit-log.js";
import { jsonValueSchema } from "../db/fhir-store.js";
import type { TenantSql } from "../db/tenant.js";
import type { Result } from "../result.js";
import { err, ok } from "../result.js";
import { deriveScope } from "../search/derive-scope.js";
import { ccpContentDigest } from "./content-digest.js";
import type { CcpError } from "./errors.js";
import { LEAF_PATHS, resolvePath } from "./leaf-paths.js";
import { buildCcpReceipt } from "./receipt.js";
import type { CcpDocument, CcpInput, CcpSpanDraft } from "./schemas.js";
import { CCP_VERSION, ccpDocumentSchema, ccpInputSchema } from "./schemas.js";
import type { CcpGroup, CcpGroupSpan } from "./serialize.js";
import { serializeCcp } from "./serialize.js";
import { orderUShape } from "./ushape.js";

const gucRowSchema = z.object({ practice_id: z.uuid() });

const resourceRowSchema = z.object({
  id: z.uuid(),
  type: z.string().min(1),
  content: z.record(z.string(), jsonValueSchema),
  version_id: z.string().min(1),
  last_updated: z.string().min(1)
});

type ResourceRow = z.infer<typeof resourceRowSchema>;

function defaultNow(): string {
  return new Date().toISOString();
}

/** The bound tenant id from the transaction GUC (T7: never caller input). */
async function boundPracticeId(sql: TenantSql): Promise<string> {
  const rows = await sql`
    select (select safe_uuid(current_setting('app.current_practice_id', true)))::text as practice_id`;
  const parsed = gucRowSchema.safeParse(rows[0]);
  // Calling buildCcp outside a tenant transaction is a programmer error (CQ2).
  if (!parsed.success) throw new Error("buildCcp requires a bound practice context");
  return parsed.data.practice_id;
}

/**
 * THE single canonical read in ccp/** (Class 2): ids come only from the parsed
 * response, and FORCE RLS bounds the row set to the bound tenant — a foreign or
 * stale id simply does not resolve.
 */
async function readScopedRows(
  sql: TenantSql,
  ids: readonly string[]
): Promise<readonly ResourceRow[]> {
  const rows = await sql`
    select id::text as id, type, content, version_id::text as version_id,
      to_char(last_updated at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_updated
    from fhir_resources
    where id = any(${[...ids]}::uuid[])`;
  return rows.map((row: unknown) => resourceRowSchema.parse(row));
}

/**
 * Class 1a+4 (purpose/subject laundering): the receipt on the response must
 * name THIS tenant, THIS purpose, THIS actor, and an explicit allow — else the
 * projection would audit the read under attributes the data was never
 * authorized for. Mirrors appendAuditRowTx's own mis-attribution guard.
 */
function receiptMatches(req: CcpInput, gucPracticeId: string): boolean {
  const receipt = req.response.policyReceipt;
  return (
    receipt.decision === "allow" &&
    receipt.practiceId.toLowerCase() === gucPracticeId.toLowerCase() &&
    receipt.purposeOfUse === req.purposeOfUse &&
    receipt.actorId === req.subject.id
  );
}

/** Receipt, resolution, type, and scope guards — first failure wins, fail-closed. */
async function resolveScopedRows(
  sql: TenantSql,
  req: CcpInput,
  gucPracticeId: string,
  now: () => string
): Promise<Result<readonly ResourceRow[], CcpError>> {
  if (!receiptMatches(req, gucPracticeId)) {
    return err({
      code: "RECEIPT_MISMATCH",
      message: "response receipt does not match this build's tenant, purpose, actor, or decision"
    });
  }
  const ids = [...new Set(req.response.results.map((hit) => hit.resourceId))];
  const rows = ids.length === 0 ? [] : await readScopedRows(sql, ids);
  if (rows.length !== ids.length) {
    // Foreign or stale ids: count only — no partial document, no id oracle.
    return err({
      code: "UNRESOLVED_RESULT",
      message: "result ids did not resolve in this tenant",
      count: ids.length - rows.length
    });
  }
  const typeById = new Map(rows.map((row) => [row.id, row.type]));
  const mislabeled = req.response.results.filter(
    (hit) => typeById.get(hit.resourceId) !== hit.resourceType
  ).length;
  if (mislabeled > 0) {
    // Class 1b: a relabeled hit would pick the wrong leaf table (mis-attribution).
    return err({
      code: "TYPE_MISMATCH",
      message: "result resourceType does not match the canonical row",
      count: mislabeled
    });
  }
  // Class 1 (latent fail-open): re-derive the ABAC scope — RLS is tenant-, not
  // policy-scoped, so a same-tenant policy-denied id would otherwise resolve.
  // deriveScope is a pure policy function of the request: no retrieval happens
  // here, so this is not scope-after-retrieve.
  const scope = deriveScope(req.subject, req.purposeOfUse, gucPracticeId, now);
  const excluded = rows.filter((row) => !scope.allowed.includes(row.type)).length;
  if (excluded > 0) {
    return err({
      code: "SCOPE_EXCLUDED_TYPE",
      message: "resolved rows include a type outside the derived policy scope",
      count: excluded
    });
  }
  return ok(rows);
}

function extractGroup(row: ResourceRow): CcpGroup {
  const paths = LEAF_PATHS[row.type];
  // Scope guarantees type is searchable; a missing table entry is table drift.
  if (paths === undefined) throw new Error(`no declared CCP leaf paths for type ${row.type}`);
  const spans: CcpGroupSpan[] = [];
  for (const jsonPath of paths) {
    const value = resolvePath(row.content, jsonPath);
    if (value !== undefined) spans.push({ jsonPath, value });
  }
  return {
    resourceType: row.type,
    resourceId: row.id,
    lastUpdated: row.last_updated,
    versionId: row.version_id,
    spans
  };
}

/** Groups in U-shape emission order, derived from the response's rank order. */
function rankedGroups(req: CcpInput, rows: readonly ResourceRow[]): readonly CcpGroup[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const inRankOrder: CcpGroup[] = [];
  const seen = new Set<string>();
  for (const hit of req.response.results) {
    if (seen.has(hit.resourceId)) continue;
    seen.add(hit.resourceId);
    const row = byId.get(hit.resourceId);
    if (row === undefined) throw new Error("resolved row set diverged from the result ids");
    inRankOrder.push(extractGroup(row));
  }
  return orderUShape(inRankOrder);
}

function flattenSpans(groups: readonly CcpGroup[]): readonly CcpSpanDraft[] {
  return groups.flatMap((group) =>
    group.spans.map((span) => ({
      resourceId: group.resourceId,
      resourceType: group.resourceType,
      jsonPath: span.jsonPath,
      value: span.value,
      lastUpdated: group.lastUpdated,
      versionId: group.versionId
    }))
  );
}

/** Append the ONE audit row for this build; returns its row_hash (T8). */
async function auditProjection(
  sql: TenantSql,
  req: CcpInput,
  gucPracticeId: string,
  outcome: { readonly decision: Decision; readonly reason: string; readonly timestamp: string }
): Promise<string> {
  const receipt = buildCcpReceipt({
    decision: outcome.decision,
    actorId: req.subject.id,
    practiceId: gucPracticeId,
    purposeOfUse: req.purposeOfUse,
    reason: outcome.reason,
    timestamp: outcome.timestamp
  });
  const { auditRowHash } = await appendAuditRowTx(sql, receipt);
  return auditRowHash;
}

function denyReason(error: CcpError, sourceAuditEventId: string): string {
  return `ccp-denied code=${error.code} count=${String(error.count ?? 0)} src=${sourceAuditEventId}`;
}

export async function buildCcp(
  sql: TenantSql,
  input: unknown
): Promise<Result<CcpDocument, CcpError>> {
  // The ONE untrusted boundary. Pre-parse failures append NO audit row (3a).
  const parsed = ccpInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({ code: "MALFORMED_INPUT", message: "malformed CCP request" });
  }
  const req = parsed.data;
  const gucPracticeId = await boundPracticeId(sql);
  const sourceAuditEventId = req.response.auditEventId;
  const now = defaultNow;
  const guarded = await resolveScopedRows(sql, req, gucPracticeId, now);
  if (!guarded.ok) {
    // Post-parse denials still audit — a decision was evaluated (T8).
    await auditProjection(sql, req, gucPracticeId, {
      decision: "deny",
      reason: denyReason(guarded.error, sourceAuditEventId),
      timestamp: now()
    });
    return guarded;
  }
  const groups = rankedGroups(req, guarded.data);
  const text = serializeCcp(
    { sourceAuditEventId, excludedByPolicy: req.response.excludedByPolicy.resourceTypes },
    groups
  );
  const drafts = flattenSpans(groups);
  const digest = ccpContentDigest(drafts, text, sourceAuditEventId);
  const auditRowHash = await auditProjection(sql, req, gucPracticeId, {
    decision: "allow",
    reason: `ccp-projection spans=${String(drafts.length)} src=${sourceAuditEventId} contentDigest=${digest}`,
    timestamp: now()
  });
  const document: CcpDocument = {
    version: CCP_VERSION,
    auditEventId: auditRowHash,
    practiceId: gucPracticeId,
    generatedAt: now(),
    spans: drafts.map((draft) => ({ ...draft, auditHash: auditRowHash })),
    excludedByPolicy: req.response.excludedByPolicy,
    text
  };
  return ok(ccpDocumentSchema.parse(document));
}
