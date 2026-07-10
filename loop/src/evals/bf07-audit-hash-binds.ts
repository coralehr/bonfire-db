/**
 * Execution eval bf07-audit-hash-binds (BF-07 acceptance 4; danger: audit tamper).
 *
 * A CCP build appends EXACTLY ONE hash-chained 'CcpProjection' audit row and binds
 * a content digest of the projection into that row. Verified independently as the
 * migration OWNER (RLS-exempt, raw TCP): doc.auditEventId is present exactly once
 * with resource_type='CcpProjection', decision='allow', and the bound practice_id;
 * every span.auditHash equals it; the row's reason carries contentDigest=<64hex>;
 * and RECOMPUTING that digest (sha256 of the RFC-8785 canonical JSON of
 * {spans:[{resourceId,versionId,jsonPath,value}], text, sourceAuditEventId}) over
 * the returned document reproduces it byte-for-byte — while the same recompute over
 * a MUTATED span value diverges, so tamper is detectable. The canonicalizer is
 * re-implemented here (the harness cannot import product code) to match the digest
 * across the firewall.
 *
 * Inversion: dropping sourceAuditEventId from the product digest preimage -> the
 * persisted digest no longer matches the eval's recompute -> red.
 */
import { createHash } from "node:crypto";
import postgres from "postgres";
import { buildCcpDoc, valueObservation } from "./bf07-ccp-util.js";
import { fail, ownerUrl, pass } from "./eval-util.js";

const EVAL_ID = "bf07-audit-hash-binds";
/** A non-integer value in the corpus keeps the digest over mixed value types. */
const NON_INTEGER_VALUE = 1.4;
const SECOND_VALUE = 2;
const practice = crypto.randomUUID();
const owner = postgres(ownerUrl(), { max: 1, onnotice: () => undefined });

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** RFC-8785 canonical JSON, byte-identical to packages/core/src/db/canonical-json.ts. */
function canonicalizeJson(value: Json): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  const members = Object.keys(value)
    .sort()
    .map((key) => {
      const child = value[key];
      return child === undefined ? undefined : `${JSON.stringify(key)}:${canonicalizeJson(child)}`;
    })
    .filter((member): member is string => member !== undefined);
  return `{${members.join(",")}}`;
}

interface Span {
  readonly resourceId: string;
  readonly versionId: string;
  readonly jsonPath: string;
  readonly value: string | number | boolean;
}

/** Mirror of ccp/content-digest.ts: sha256 over the tamper-envelope preimage. */
function contentDigest(spans: readonly Span[], text: string, sourceAuditEventId: string): string {
  const canonical = canonicalizeJson({
    spans: spans.map((s) => ({
      resourceId: s.resourceId,
      versionId: s.versionId,
      jsonPath: s.jsonPath,
      value: s.value
    })),
    text,
    sourceAuditEventId
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

interface Row {
  readonly decision: string;
  readonly resource_type: string;
  readonly practice_id: string;
  readonly reason: string;
}

try {
  const { doc, response } = buildCcpDoc(
    EVAL_ID,
    practice,
    [
      valueObservation("zzbinds first synthetic finding", NON_INTEGER_VALUE),
      valueObservation("zzbinds second synthetic finding", SECOND_VALUE)
    ],
    "zzbinds"
  );

  // Exactly one CcpProjection audit row, keyed by the document's auditEventId.
  const rows = (await owner`
    select decision, resource_type, practice_id::text as practice_id, reason
    from audit_log where row_hash = ${doc.auditEventId}`) as unknown as Row[];
  const row = rows[0];
  if (rows.length !== 1 || row === undefined)
    fail(
      EVAL_ID,
      `expected exactly 1 audit row for ${doc.auditEventId}, got ${String(rows.length)}`
    );
  if (
    row.resource_type !== "CcpProjection" ||
    row.decision !== "allow" ||
    row.practice_id !== practice
  )
    fail(EVAL_ID, `audit row wrong: ${JSON.stringify(row)}`);
  if (doc.practiceId !== practice)
    fail(EVAL_ID, `doc.practiceId ${doc.practiceId} != bound ${practice}`);

  // Every span carries the CcpProjection row_hash as its auditHash.
  for (const span of doc.spans) {
    if (span.auditHash !== doc.auditEventId)
      fail(EVAL_ID, `span.auditHash ${span.auditHash} != auditEventId ${doc.auditEventId}`);
  }

  // The reason binds the content digest; recompute it over the returned document.
  const digestMatch = /contentDigest=([0-9a-f]{64})/.exec(row.reason);
  const persisted = digestMatch?.[1];
  if (persisted === undefined)
    fail(EVAL_ID, `reason carries no contentDigest=<64hex>: ${row.reason}`);
  const sourceAuditEventId = response.auditEventId;
  if (!row.reason.includes(`src=${sourceAuditEventId}`))
    fail(EVAL_ID, `reason does not fold in the source audit event id: ${row.reason}`);

  const recomputed = contentDigest(doc.spans, doc.text, sourceAuditEventId);
  if (recomputed !== persisted)
    fail(EVAL_ID, `recomputed digest ${recomputed} != persisted ${persisted}`);

  // Tamper: the same recompute over a MUTATED span value must diverge (detected).
  const first = doc.spans[0];
  if (first === undefined) fail(EVAL_ID, "no span to tamper");
  const tampered: Span[] = [
    {
      ...first,
      value: typeof first.value === "string" ? `${first.value}!` : Number(first.value) + 1
    },
    ...doc.spans.slice(1)
  ];
  const tamperedDigest = contentDigest(tampered, doc.text, sourceAuditEventId);
  if (tamperedDigest === persisted)
    fail(EVAL_ID, "mutating a span value did not change the content digest (tamper undetectable)");

  pass(
    EVAL_ID,
    `1 CcpProjection audit row; ${String(doc.spans.length)} spans bound to its row_hash; contentDigest recomputes and detects value tamper`
  );
} finally {
  await owner.end({ timeout: 5 });
}
