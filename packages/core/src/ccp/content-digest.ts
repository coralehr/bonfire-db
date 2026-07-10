/**
 * The tamper envelope (Class 4b + replay): SHA-256 over the RFC 8785 canonical
 * JSON of { spans (in EMITTED order), text, sourceAuditEventId }. It covers
 * value tamper (span values), prose tamper (the consumed text), reorder tamper
 * (span order is part of the preimage), replay/staleness (each span carries its
 * versionId), and provenance (the source search's audit event id links the CCP
 * to the scoped read it derived from). Spans carry NO auditHash here: the
 * digest is folded into the audit row's reason, which sits inside the row-hash
 * preimage, so including the row hash would be circular.
 */
import { canonicalizeJson, sha256Hex } from "../db/canonical-json.js";
import type { CcpSpanDraft } from "./schemas.js";

export function ccpContentDigest(
  spans: readonly CcpSpanDraft[],
  text: string,
  sourceAuditEventId: string
): string {
  return sha256Hex(
    canonicalizeJson({
      spans: spans.map((span) => ({
        resourceId: span.resourceId,
        versionId: span.versionId,
        jsonPath: span.jsonPath,
        value: span.value
      })),
      text,
      sourceAuditEventId
    })
  );
}
