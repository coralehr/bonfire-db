/**
 * Extract every FHIR Coding (an object carrying string `system` + `code`) from a
 * canonical resource, with a JSON pointer to each. The terminology validate-on-
 * write step walks these so coded fields are checked against local packs; codings
 * whose system is not a recognized clinical vocabulary are simply skipped.
 */
import type { JsonObject, JsonValue } from "../db/canonical-json.js";

export interface FhirCodingRef {
  readonly system: string;
  readonly code: string;
  readonly pointer: string;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function codingAt(node: JsonObject, pointer: string): FhirCodingRef | undefined {
  const { system, code } = node;
  if (typeof system === "string" && typeof code === "string") {
    return { system, code, pointer };
  }
  return undefined;
}

function walk(node: JsonValue, pointer: string, out: FhirCodingRef[]): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) => {
      walk(child, `${pointer}/${String(index)}`, out);
    });
    return;
  }
  if (!isJsonObject(node)) return;
  const coding = codingAt(node, pointer);
  if (coding !== undefined) out.push(coding);
  for (const [key, child] of Object.entries(node)) {
    walk(child, `${pointer}/${key}`, out);
  }
}

/** Every (system, code) coding in a canonical FHIR resource, each with a pointer. */
export function collectCodings(resource: JsonObject): FhirCodingRef[] {
  const out: FhirCodingRef[] = [];
  walk(resource, "", out);
  return out;
}
