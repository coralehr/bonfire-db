/**
 * Serialize a CCP into its compact text form (D3, EXP1-measured). Layout:
 *
 *   CCP v1 audit=<source audit event id>           - provenance ref, hoisted once
 *   excludedByPolicy: <Type>(<reason>) ...         - only when non-empty
 *   [n] <Type>/<id> @<lastUpdated> v<versionId>    - one group per resource
 *     <jsonPath>: <JSON-encoded value>             - one line per span
 *   raw FHIR escape hatch: ...
 *
 * Every span value is JSON-encoded (Class 5, non-negotiable): a clinical string
 * containing newlines or a forged "[9] Type/<id>" header can never fabricate a
 * span or group line, and the document stays losslessly invertible (group
 * headers are `[`-prefixed, span lines are 2-space-indented `path: <json>`).
 * The header carries the SOURCE search's audit event id: the CCP's own audit
 * row hash cannot appear in this text because that row's digest covers the
 * text (chicken-and-egg), so it lives on the document object instead.
 */
import type { ExcludedType } from "../search/schemas.js";
import type { CcpSpanValue } from "./schemas.js";

export interface CcpGroupSpan {
  readonly jsonPath: string;
  readonly value: CcpSpanValue;
}

/** One cited resource: its freshness stamp plus the spans projected from it. */
export interface CcpGroup {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly lastUpdated: string;
  readonly versionId: string;
  readonly spans: readonly CcpGroupSpan[];
}

export interface CcpTextHeader {
  /** The SOURCE search's audit event id — the scoped read this CCP derives from. */
  readonly sourceAuditEventId: string;
  readonly excludedByPolicy: readonly ExcludedType[];
}

const ESCAPE_HATCH_LINE = "raw FHIR escape hatch: read fhir_resources by (resourceType, id)";

export function serializeCcp(header: CcpTextHeader, groups: readonly CcpGroup[]): string {
  const lines: string[] = [`CCP v1 audit=${header.sourceAuditEventId}`];
  if (header.excludedByPolicy.length > 0) {
    const withheld = header.excludedByPolicy
      .map((entry) => `${entry.resourceType}(${entry.reason})`)
      .join(" ");
    lines.push(`excludedByPolicy: ${withheld}`);
  }
  groups.forEach((group, index) => {
    lines.push(
      `[${String(index + 1)}] ${group.resourceType}/${group.resourceId} @${group.lastUpdated} v${group.versionId}`
    );
    for (const span of group.spans) {
      lines.push(`  ${span.jsonPath}: ${JSON.stringify(span.value)}`);
    }
  });
  lines.push(ESCAPE_HATCH_LINE);
  return lines.join("\n");
}
