/**
 * spidx parity — SELF-GENERATING oracle: probe tuples are derived here from
 * the RAW corpus JSON (independent walker, never from spidx or the product
 * extractor), then for every probe the spidx id-set must equal a
 * jsonb_path_exists scan over canonical fhir_resources. Plus the
 * cross-tenant guarantee on the spidx read path itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { JsonObject } from "../../packages/core/src/index.js";
import type { CorpusEntry, TestContext, TwoPracticeSetup } from "./helpers.js";
import { closeContext, setupTwoPractices } from "./helpers.js";

interface Probe {
  readonly resourceType: string;
  readonly param: string;
  readonly shape: "reference" | "coding" | "identifier";
  readonly attr: string;
  readonly system: string | null;
  readonly value: string;
}

const REFERENCE_ATTRS: Record<string, string> = {
  Observation: "subject",
  Condition: "subject",
  Encounter: "subject",
  Procedure: "subject",
  MedicationRequest: "subject",
  DocumentReference: "subject",
  AllergyIntolerance: "patient"
};

const CODE_ATTRS: Record<string, string> = {
  Observation: "code",
  Condition: "code",
  Procedure: "code",
  AllergyIntolerance: "code",
  MedicationRequest: "medicationCodeableConcept"
};

const CLINICAL_STATUS_TYPES = ["Condition", "AllergyIntolerance"];
const IDENTIFIER_TYPES = ["Patient", "DocumentReference"];

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function codingProbes(entry: CorpusEntry, param: string, attr: string): Probe[] {
  const concept = asObject(entry.content[attr]);
  const codings = concept?.coding;
  if (!Array.isArray(codings)) return [];
  return codings.flatMap((raw) => {
    const coding = asObject(raw);
    if (coding === undefined || typeof coding.code !== "string") return [];
    return [
      {
        resourceType: entry.type,
        param,
        shape: "coding" as const,
        attr,
        system: typeof coding.system === "string" ? coding.system : null,
        value: coding.code
      }
    ];
  });
}

function referenceProbes(entry: CorpusEntry): Probe[] {
  const refAttr = REFERENCE_ATTRS[entry.type];
  const reference = refAttr === undefined ? undefined : asObject(entry.content[refAttr]);
  if (refAttr === undefined || typeof reference?.reference !== "string") return [];
  return [
    {
      resourceType: entry.type,
      param: refAttr === "patient" ? "patient" : "subject",
      shape: "reference",
      attr: refAttr,
      system: null,
      value: reference.reference
    }
  ];
}

function identifierProbes(entry: CorpusEntry): Probe[] {
  if (!IDENTIFIER_TYPES.includes(entry.type)) return [];
  const identifiers = entry.content.identifier;
  if (!Array.isArray(identifiers)) return [];
  return identifiers.flatMap((raw) => {
    const identifier = asObject(raw);
    if (identifier === undefined || typeof identifier.value !== "string") return [];
    return [
      {
        resourceType: entry.type,
        param: "identifier",
        shape: "identifier" as const,
        attr: "identifier",
        system: typeof identifier.system === "string" ? identifier.system : null,
        value: identifier.value
      }
    ];
  });
}

/** Independent probe derivation straight off the raw corpus JSON. */
function deriveProbes(entry: CorpusEntry): Probe[] {
  const codeAttr = CODE_ATTRS[entry.type];
  return [
    ...referenceProbes(entry),
    ...(codeAttr === undefined ? [] : codingProbes(entry, "code", codeAttr)),
    ...(CLINICAL_STATUS_TYPES.includes(entry.type)
      ? codingProbes(entry, "clinical-status", "clinicalStatus")
      : []),
    ...identifierProbes(entry)
  ];
}

let s: TwoPracticeSetup;
let ctx: TestContext;

async function spidxIds(practice: string, probe: Probe): Promise<string[]> {
  const rows =
    probe.shape === "reference"
      ? await ctx.owner`
          select resource_id::text as rid from spidx
          where practice_id = ${practice} and resource_type = ${probe.resourceType}
            and param_name = ${probe.param} and param_type = 'reference'
            and ref_value = ${probe.value}`
      : await ctx.owner`
          select resource_id::text as rid from spidx
          where practice_id = ${practice} and resource_type = ${probe.resourceType}
            and param_name = ${probe.param} and param_type = 'token'
            and token_code = ${probe.value}
            and token_system is not distinct from ${probe.system}`;
  return rows.map((row) => String(row.rid)).sort();
}

async function canonicalIds(practice: string, probe: Probe): Promise<string[]> {
  let rows;
  if (probe.shape === "reference") {
    rows = await ctx.owner`
      select id::text as rid from fhir_resources
      where practice_id = ${practice} and type = ${probe.resourceType}
        and content->${probe.attr}->>'reference' = ${probe.value}`;
  } else {
    const path =
      probe.shape === "coding"
        ? `$.${probe.attr}.coding[*] ? (@.code == $c && @.system == $s)`
        : `$.${probe.attr}[*] ? (@.value == $c && @.system == $s)`;
    rows = await ctx.owner`
      select id::text as rid from fhir_resources
      where practice_id = ${practice} and type = ${probe.resourceType}
        and jsonb_path_exists(content, ${path}::jsonpath, ${ctx.owner.json({ c: probe.value, s: probe.system })})`;
  }
  return rows.map((row) => String(row.rid)).sort();
}

beforeAll(async () => {
  s = await setupTwoPractices({ rebuildFirst: false });
  ctx = s.ctx;
});

afterAll(async () => {
  await closeContext(ctx);
});

describe("spidx equality lookups mirror canonical JSONB scans", () => {
  test("every derived probe yields identical id-sets from spidx and fhir_resources", async () => {
    const probes = s.corpusA.entries.flatMap(deriveProbes);
    // The corpus must actually exercise every supported param shape.
    expect(probes.some((probe) => probe.shape === "reference")).toBe(true);
    expect(probes.some((probe) => probe.shape === "coding")).toBe(true);
    expect(probes.some((probe) => probe.shape === "identifier")).toBe(true);
    expect(probes.some((probe) => probe.param === "clinical-status")).toBe(true);
    for (const probe of probes) {
      const fromSpidx = await spidxIds(s.practiceA, probe);
      const fromCanonical = await canonicalIds(s.practiceA, probe);
      expect(fromSpidx.length).toBeGreaterThan(0);
      expect(fromSpidx).toEqual(fromCanonical);
    }
  });

  test("practice A's spidx read path returns zero rows for B's subject reference", async () => {
    const bSubject = `Patient/${s.corpusB.patientId}`;
    const asA = await ctx.db.withTenant(s.practiceA, async (sql) => {
      return await sql`select resource_id from spidx where ref_value = ${bSubject}`;
    });
    expect(asA.ok).toBe(true);
    if (asA.ok) expect(asA.data.length).toBe(0);
    const oracle = await ctx.owner`
      select resource_id from spidx where ref_value = ${bSubject} and practice_id = ${s.practiceB}`;
    expect(oracle.length).toBeGreaterThan(0);
  });
});
