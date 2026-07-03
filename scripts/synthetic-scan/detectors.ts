/**
 * Field-aware detectors over PARSED FHIR JSON (never regex-over-text).
 *
 * Six signal classes; the strongest is the Synthea marker INVERSION: instead
 * of proving a value is real, any HumanName part WITHOUT the synthetic digit
 * marker is the anomaly. Findings carry a sha256 of the matched value — the
 * scanner never echoes a potentially real identifier back to a terminal/log.
 */
import { createHash } from "node:crypto";
import {
  COMMON_FIRST_NAMES,
  MRN_SYSTEM_ALLOWLIST,
  NPI_ALLOWLIST,
  SYNTHETIC_NAME_ALLOWLIST
} from "./config.js";
import {
  isFictionalPhone,
  isLuhnValidNpi,
  isNanpValidPhone,
  isPlausibleBirthDate,
  isStructurallyValidSsn
} from "./identifiers.js";

export type RuleId =
  | "name-marker"
  | "ssn-structural"
  | "phone-nanp"
  | "npi-luhn"
  | "mrn-system"
  | "compound-identity";

export const ALL_RULES: readonly RuleId[] = [
  "name-marker",
  "ssn-structural",
  "phone-nanp",
  "npi-luhn",
  "mrn-system",
  "compound-identity"
];

export interface Finding {
  readonly rule: RuleId;
  readonly pointer: string;
  /** sha256 of the matched value — the raw value is never printed. */
  readonly valueSha256: string;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

type NodeVisitor = (node: Record<string, unknown>, pointer: string) => void;

function walkObjects(value: unknown, pointer: string, visit: NodeVisitor): void {
  if (isUnknownArray(value)) {
    value.forEach((item, index) => {
      walkObjects(item, `${pointer}/${String(index)}`, visit);
    });
    return;
  }
  if (!isPlainObject(value)) return;
  visit(value, pointer);
  for (const key of Object.keys(value)) {
    walkObjects(value[key], `${pointer}/${key}`, visit);
  }
}

const SYNTHETIC_DIGIT_MARKER = /\d/;
const NPI_SYSTEM = "http://hl7.org/fhir/sid/us-npi";
const MRN_TYPE_CODE = "MR";

interface NamePart {
  readonly part: string;
  readonly key: string;
}

function humanNameParts(node: Record<string, unknown>): NamePart[] {
  const parts: NamePart[] = [];
  const family = node.family;
  if (typeof family === "string") parts.push({ part: family, key: "family" });
  const given = node.given;
  if (isUnknownArray(given)) {
    given.forEach((item, index) => {
      if (typeof item === "string") parts.push({ part: item, key: `given/${String(index)}` });
    });
  }
  return parts;
}

/** Class 1 — marker inversion: unmarked HumanName parts are the anomaly. */
function detectNameMarker(node: Record<string, unknown>, pointer: string, out: Finding[]): void {
  if (!("family" in node) && !("given" in node)) return;
  for (const { part, key } of humanNameParts(node)) {
    if (SYNTHETIC_DIGIT_MARKER.test(part)) continue;
    if (SYNTHETIC_NAME_ALLOWLIST.includes(part.toLowerCase())) continue;
    out.push({ rule: "name-marker", pointer: `${pointer}/${key}`, valueSha256: sha256Hex(part) });
  }
}

/** Class 2 — a STRUCTURALLY VALID SSN anywhere in the tree is a finding. */
function detectSsnStrings(node: Record<string, unknown>, pointer: string, out: Finding[]): void {
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (typeof value !== "string") continue;
    if (isStructurallyValidSsn(value)) {
      out.push({
        rule: "ssn-structural",
        pointer: `${pointer}/${key}`,
        valueSha256: sha256Hex(value)
      });
    }
  }
}

/** Class 3 — NANP-valid phone outside the fictional 555-0100..0199 range. */
function detectPhone(node: Record<string, unknown>, pointer: string, out: Finding[]): void {
  if (node.system !== "phone") return;
  const value = node.value;
  if (typeof value !== "string") return;
  if (!isNanpValidPhone(value) || isFictionalPhone(value)) return;
  out.push({ rule: "phone-nanp", pointer: `${pointer}/value`, valueSha256: sha256Hex(value) });
}

function hasMrnTypeCode(node: Record<string, unknown>): boolean {
  const type = node.type;
  if (!isPlainObject(type)) return false;
  const coding = type.coding;
  if (!isUnknownArray(coding)) return false;
  return coding.some((entry) => isPlainObject(entry) && entry.code === MRN_TYPE_CODE);
}

/** Classes 4 + 5 — identifier-shaped nodes: Luhn-valid NPIs, unallowlisted MRN systems. */
function detectIdentifier(node: Record<string, unknown>, pointer: string, out: Finding[]): void {
  const system = node.system;
  const value = node.value;
  if (typeof value !== "string") return;
  if (system === NPI_SYSTEM && isLuhnValidNpi(value) && !NPI_ALLOWLIST.includes(value)) {
    out.push({ rule: "npi-luhn", pointer: `${pointer}/value`, valueSha256: sha256Hex(value) });
  }
  const mrnShaped =
    hasMrnTypeCode(node) || (typeof system === "string" && system.toLowerCase().includes("mrn"));
  if (mrnShaped && (typeof system !== "string" || !MRN_SYSTEM_ALLOWLIST.includes(system))) {
    out.push({ rule: "mrn-system", pointer: `${pointer}/system`, valueSha256: sha256Hex(value) });
  }
}

/** Class 6 — weak signals only count together: dictionary name + plausible DOB. */
function detectCompound(resource: Record<string, unknown>, base: string, out: Finding[]): void {
  const birthDate = resource.birthDate;
  if (typeof birthDate !== "string" || !isPlausibleBirthDate(birthDate)) return;
  const dictionaryHits: string[] = [];
  walkObjects(resource, base, (node) => {
    if (!("family" in node) && !("given" in node)) return;
    for (const { part } of humanNameParts(node)) {
      if (COMMON_FIRST_NAMES.includes(part.toLowerCase())) dictionaryHits.push(part);
    }
  });
  if (dictionaryHits.length === 0) return;
  out.push({
    rule: "compound-identity",
    pointer: base,
    valueSha256: sha256Hex(dictionaryHits.join("|"))
  });
}

/** Run every detector over one parsed FHIR resource. */
export function scanResource(resource: Record<string, unknown>, basePointer: string): Finding[] {
  const findings: Finding[] = [];
  walkObjects(resource, basePointer, (node, pointer) => {
    detectNameMarker(node, pointer, findings);
    detectSsnStrings(node, pointer, findings);
    detectPhone(node, pointer, findings);
    detectIdentifier(node, pointer, findings);
  });
  detectCompound(resource, basePointer, findings);
  return findings;
}
