/**
 * Extract searchable free text from a canonical FHIR resource for the v0 one-row
 * indexer. Pulls the human-readable, clinically-salient fields (coded displays +
 * codes, notes, values, names, attachment refs) into one `content_text` blob and
 * picks a per-type primary JSONB path for the citation. Deliberately narrow: only
 * declared text-bearing fields are read (never a blind recursive walk that would
 * index system URIs and ids). `path` is a coarse per-type anchor for v0 — span-
 * level citation precision is BF-07's job.
 */
import type { JsonObject, JsonValue } from "../db/canonical-json.js";

export interface ExtractedText {
  readonly text: string;
  readonly path: string;
}

/** Per-type primary field the citation path anchors to (fallback: the type name). */
const PRIMARY_PATH: Readonly<Record<string, string>> = {
  Patient: "name",
  Encounter: "type",
  Condition: "code",
  Observation: "code",
  MedicationRequest: "medicationCodeableConcept",
  AllergyIntolerance: "code",
  Procedure: "code",
  DocumentReference: "content"
};

/** Resource fields carrying a CodeableConcept (or an array of them). */
const CODEABLE_FIELDS = ["code", "medicationCodeableConcept", "type", "clinicalStatus", "category"];

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function asArray(value: JsonValue | undefined): readonly JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pushDefined(out: string[], value: string | undefined): void {
  if (value !== undefined) out.push(value);
}

function codeableTokens(value: JsonValue | undefined): string[] {
  const cc = asObject(value);
  if (cc === undefined) return [];
  const out: string[] = [];
  pushDefined(out, asString(cc.text));
  for (const coding of asArray(cc.coding) ?? []) {
    const c = asObject(coding);
    if (c === undefined) continue;
    pushDefined(out, asString(c.display));
    pushDefined(out, asString(c.code));
  }
  return out;
}

function codeableFieldTokens(content: JsonObject): string[] {
  const out: string[] = [];
  for (const field of CODEABLE_FIELDS) {
    const value = content[field];
    const arr = asArray(value);
    if (arr !== undefined) for (const item of arr) out.push(...codeableTokens(item));
    else out.push(...codeableTokens(value));
  }
  return out;
}

function noteTokens(content: JsonObject): string[] {
  const out: string[] = [];
  for (const note of asArray(content.note) ?? []) {
    const o = asObject(note);
    pushDefined(out, o === undefined ? undefined : asString(o.text));
  }
  return out;
}

function valueTokens(content: JsonObject): string[] {
  const out: string[] = [];
  pushDefined(out, asString(content.valueString));
  const vq = asObject(content.valueQuantity);
  if (vq !== undefined) {
    if (typeof vq.value === "number") out.push(String(vq.value));
    pushDefined(out, asString(vq.unit));
  }
  out.push(...codeableTokens(content.valueCodeableConcept));
  return out;
}

function nameTokens(content: JsonObject): string[] {
  const out: string[] = [];
  for (const name of asArray(content.name) ?? []) {
    const o = asObject(name);
    if (o === undefined) continue;
    pushDefined(out, asString(o.family));
    for (const given of asArray(o.given) ?? []) pushDefined(out, asString(given));
  }
  return out;
}

function attachmentTokens(content: JsonObject): string[] {
  const out: string[] = [];
  for (const item of asArray(content.content) ?? []) {
    const o = asObject(item);
    const att = o === undefined ? undefined : asObject(o.attachment);
    if (att === undefined) continue;
    pushDefined(out, asString(att.url));
    pushDefined(out, asString(att.title));
  }
  return out;
}

export function extractSearchText(type: string, content: JsonObject): ExtractedText {
  const tokens = [
    ...codeableFieldTokens(content),
    ...noteTokens(content),
    ...valueTokens(content),
    ...nameTokens(content),
    ...attachmentTokens(content)
  ];
  return { text: tokens.join(" ").trim(), path: PRIMARY_PATH[type] ?? type };
}
