/**
 * Canonical JSON-pointer diff for round-trip losslessness. `structuralDiffs`
 * compares a scribe input against its typed→FHIR→typed recovery; `decimalDiffs`
 * catches wire-byte loss the structural pass cannot see — a FHIR `decimal` whose
 * source text carries trailing-zero scale (e.g. `2.00`) that JCS canonicalizes
 * to `2`. Every reported diff must be matched by a loss-ledger entry or the gate
 * fails (the lossless-or-ledgered invariant, ratchet BP-008).
 */
import type { JsonObject, JsonValue } from "../db/canonical-json.js";
import { canonicalizeJson } from "../db/canonical-json.js";

export type JsonDiffKind = "changed" | "missing" | "unexpected" | "decimal-scale";

export interface RoundTripDiff {
  readonly resourceType: string;
  readonly pointer: string;
  readonly kind: JsonDiffKind;
  readonly detail: string;
}

interface RawDiff {
  readonly pointer: string;
  readonly kind: JsonDiffKind;
  readonly detail: string;
}

const DETAIL_MAX = 60;

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapePointer(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function truncate(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

function collectArray(
  expected: readonly JsonValue[],
  actual: readonly JsonValue[],
  pointer: string,
  out: RawDiff[]
): void {
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    const expectedItem = expected[index];
    const actualItem = actual[index];
    const childPointer = `${pointer}/${String(index)}`;
    if (expectedItem === undefined) {
      out.push({ pointer: childPointer, kind: "unexpected", detail: "extra array element" });
    } else if (actualItem === undefined) {
      out.push({ pointer: childPointer, kind: "missing", detail: "missing array element" });
    } else {
      collect(expectedItem, actualItem, childPointer, out);
    }
  }
}

function collectObject(
  expected: JsonObject,
  actual: JsonObject,
  pointer: string,
  out: RawDiff[]
): void {
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) {
    const expectedValue = expected[key];
    const actualValue = actual[key];
    const childPointer = `${pointer}/${escapePointer(key)}`;
    if (expectedValue === undefined) {
      out.push({ pointer: childPointer, kind: "unexpected", detail: `extra key ${key}` });
    } else if (actualValue === undefined) {
      out.push({ pointer: childPointer, kind: "missing", detail: `missing key ${key}` });
    } else {
      collect(expectedValue, actualValue, childPointer, out);
    }
  }
}

function collect(expected: JsonValue, actual: JsonValue, pointer: string, out: RawDiff[]): void {
  if (canonicalizeJson(expected) === canonicalizeJson(actual)) return;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    collectArray(expected, actual, pointer, out);
  } else if (isJsonObject(expected) && isJsonObject(actual)) {
    collectObject(expected, actual, pointer, out);
  } else {
    out.push({
      pointer,
      kind: "changed",
      detail: `${truncate(canonicalizeJson(expected))} != ${truncate(canonicalizeJson(actual))}`
    });
  }
}

/** Structural diff between an expected and an actual canonical JSON object. */
export function structuralDiffs(
  resourceType: string,
  expected: JsonObject,
  actual: JsonObject
): RoundTripDiff[] {
  const raw: RawDiff[] = [];
  collect(expected, actual, "", raw);
  return raw.map((diff) => ({ resourceType, ...diff }));
}

interface NumberSource {
  readonly numberSource: string;
  readonly numberValue: number;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberSource(value: unknown): value is NumberSource {
  return (
    isUnknownRecord(value) &&
    typeof value.numberSource === "string" &&
    typeof value.numberValue === "number"
  );
}

function annotateNumberSources(
  _key: string,
  value: unknown,
  context?: { readonly source?: string }
): unknown {
  if (typeof value === "number" && context !== undefined && typeof context.source === "string") {
    return { numberSource: context.source, numberValue: value } satisfies NumberSource;
  }
  return value;
}

function walkNumbers(node: unknown, pointer: string, out: RawDiff[]): void {
  if (isNumberSource(node)) {
    const canonical = canonicalizeJson(node.numberValue);
    if (node.numberSource !== canonical) {
      out.push({ pointer, kind: "decimal-scale", detail: `${node.numberSource} → ${canonical}` });
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child, index) => {
      walkNumbers(child, `${pointer}/${String(index)}`, out);
    });
    return;
  }
  if (isUnknownRecord(node)) {
    for (const [key, child] of Object.entries(node)) {
      walkNumbers(child, `${pointer}/${escapePointer(key)}`, out);
    }
  }
}

/** Detect FHIR decimal-scale normalization (trailing-zero loss) in raw JSON text. */
export function decimalDiffs(resourceType: string, rawJsonText: string): RoundTripDiff[] {
  const annotated: unknown = JSON.parse(rawJsonText, annotateNumberSources);
  const raw: RawDiff[] = [];
  walkNumbers(annotated, "", raw);
  return raw.map((diff) => ({ resourceType, ...diff }));
}
