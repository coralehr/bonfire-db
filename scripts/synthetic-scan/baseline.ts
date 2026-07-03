/**
 * Reviewed false-positive baseline. Content-based fingerprints
 * (path + JSON pointer + rule + hashed value) survive squash-merges, and every
 * entry needs a reason + author — reviewed like code. NO inline pragmas exist:
 * a commit introducing PHI cannot silence its own alarm.
 */
import { readFileSync } from "node:fs";
import type { Finding } from "./detectors.js";
import { isPlainObject, isUnknownArray, sha256Hex } from "./detectors.js";

function parseEntry(entry: unknown, index: number): string {
  if (!isPlainObject(entry)) {
    throw new Error(`baseline entry ${String(index)} is not an object`);
  }
  const fingerprint = entry.fingerprint;
  const reason = entry.reason;
  const addedBy = entry.added_by;
  if (typeof fingerprint !== "string" || fingerprint.length === 0) {
    throw new Error(`baseline entry ${String(index)} needs a non-empty fingerprint`);
  }
  if (typeof reason !== "string" || reason.length === 0) {
    throw new Error(`baseline entry ${String(index)} needs a non-empty reason`);
  }
  if (typeof addedBy !== "string" || addedBy.length === 0) {
    throw new Error(`baseline entry ${String(index)} needs a non-empty added_by`);
  }
  return fingerprint;
}

/** Load the fingerprint set; a malformed baseline is an operational error. */
export function loadBaseline(baselinePath: string): Set<string> {
  const raw: unknown = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (!isPlainObject(raw) || !isUnknownArray(raw.entries)) {
    throw new Error("baseline.json must be an object with an entries array");
  }
  return new Set(raw.entries.map((entry, index) => parseEntry(entry, index)));
}

/** Stable content fingerprint for one finding in one file. */
export function fingerprintOf(filePath: string, finding: Finding): string {
  return sha256Hex([filePath, finding.pointer, finding.rule, finding.valueSha256].join("|"));
}
