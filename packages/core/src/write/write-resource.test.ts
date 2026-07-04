/**
 * The typed write primitive against the live compose DB (as bonfire_app, after
 * migrate + fhir:load-terminology). Proves: canonical FHIR (not the typed input)
 * is persisted in ONE atomic transaction; practice_id is server-side; write_inputs
 * replay re-derives the canonical FHIR; required codes fail-closed while
 * extensible misses WARN with a pack version; SNOMED format-only never blocks;
 * validate-on-write makes ZERO network calls; and cross-tenant reads see nothing.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { contentHash } from "../db/canonical-json.js";
import { createSqlClient } from "../db/client.js";
import { resolveDatabaseTarget } from "../db/env.js";
import { createTenantDb } from "../db/tenant.js";
import {
  fromFhir,
  type Result,
  toFhir,
  toJsonObject,
  type WriteError,
  type WriteResult,
  writeScribeResource
} from "../index.js";

const ICD = "http://hl7.org/fhir/sid/icd-10-cm";
const SNOMED = "http://snomed.info/sct";
const PRACTICE_A = randomUUID();
const PRACTICE_B = randomUUID();

const sql = createSqlClient(resolveDatabaseTarget(), { max: 1 });
const db = createTenantDb(sql);

function patientInput(id: string): Record<string, unknown> {
  return {
    resourceType: "Patient",
    id,
    identifier: [{ system: "http://myhospital.org/mrn", value: `MRN-${id.slice(0, 8)}` }],
    name: [{ family: "Writetest" }],
    gender: "male"
  };
}

function conditionInput(id: string, code: string, clinical = "active"): Record<string, unknown> {
  return {
    resourceType: "Condition",
    id,
    clinicalStatus: {
      coding: [
        { system: "http://terminology.hl7.org/CodeSystem/condition-clinical", code: clinical }
      ]
    },
    verificationStatus: {
      coding: [
        { system: "http://terminology.hl7.org/CodeSystem/condition-ver-status", code: "confirmed" }
      ]
    },
    category: [
      {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/condition-category",
            code: "problem-list-item"
          }
        ]
      }
    ],
    code: { coding: [{ system: ICD, code }] },
    subject: { reference: `Patient/${id}` }
  };
}

function procedureInput(id: string, sctid: string): Record<string, unknown> {
  return {
    resourceType: "Procedure",
    id,
    status: "completed",
    code: { coding: [{ system: SNOMED, code: sctid }] },
    subject: { reference: `Patient/${id}` },
    performedDateTime: "2024-01-10T09:00:00Z"
  };
}

function consentInput(id: string): Record<string, unknown> {
  return {
    resourceType: "Consent",
    id,
    status: "active",
    scope: {
      coding: [
        { system: "http://terminology.hl7.org/CodeSystem/consentscope", code: "patient-privacy" }
      ]
    },
    category: [{ coding: [{ system: "http://loinc.org", code: "59284-0" }] }],
    patient: { reference: `Patient/${id}` },
    dateTime: "2024-01-01T00:00:00Z",
    policyRule: {
      coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "OPTIN" }]
    }
  };
}

async function rowCounts(id: string): Promise<{ latest: number; history: number; inputs: number }> {
  const result = await db.withTenant(PRACTICE_A, async (sql) => {
    const rows = await sql<{ latest: number; history: number; inputs: number }[]>`
      select (select count(*) from fhir_resources where id = ${id})::int as latest,
             (select count(*) from history where id = ${id})::int as history,
             (select count(*) from write_inputs where fhir_resource_id = ${id})::int as inputs`;
    return rows[0];
  });
  if (!result.ok || result.data === undefined) throw new Error("rowCounts failed");
  return result.data;
}

/** Run a write inside practice A's transaction and return its typed Result. */
async function writeAttempt(
  input: Record<string, unknown>
): Promise<Result<WriteResult, WriteError>> {
  const written = await db.withTenant(PRACTICE_A, async (sql) => writeScribeResource(sql, input));
  if (!written.ok) throw new Error("withTenant failed");
  return written.data;
}

/** Run a write expected to succeed and return the unwrapped WriteResult. */
async function writeOk(input: Record<string, unknown>): Promise<WriteResult> {
  const attempt = await writeAttempt(input);
  if (!attempt.ok) throw new Error(`expected write to succeed: ${attempt.error.code}`);
  return attempt.data;
}

beforeAll(async () => {
  const loaded = await db.withTenant(PRACTICE_A, async (sql) => {
    const rows = await sql<
      { n: number }[]
    >`select count(*)::int as n from terminology_concept where system = ${ICD}`;
    return rows[0]?.n ?? 0;
  });
  if (!loaded.ok || loaded.data === 0) {
    throw new Error("terminology not loaded — run `bun run fhir:load-terminology` before tests");
  }
});

afterAll(async () => {
  await db.end();
});

describe("canonical FHIR is persisted server-side in one transaction", () => {
  test("write persists canonical FHIR (not the typed input) with the caller's practice_id", async () => {
    const id = randomUUID();
    const result = await writeOk(patientInput(id));
    expect(result.record.versionId).toBe("1");
    expect(result.record.practiceId).toBe(PRACTICE_A);
    const stored = await db.withTenant(PRACTICE_A, async (sql) => {
      const rows = await sql<{ content: Record<string, unknown>; practice_id: string }[]>`
        select content, practice_id from fhir_resources where id = ${id}`;
      return rows[0];
    });
    if (!stored.ok || stored.data === undefined) throw new Error("read failed");
    // Canonical FHIR — carries the server-stamped US Core profile the input lacked.
    expect(stored.data.content.resourceType).toBe("Patient");
    expect(stored.data.content.meta).toBeDefined();
    // practice_id came from the GUC, never from client input (input has none).
    expect(stored.data.practice_id).toBe(PRACTICE_A);
    expect(patientInput(id).practice_id).toBeUndefined();
  });

  test("a forced mid-transaction failure leaves zero rows across all three tables", async () => {
    const id = randomUUID();
    const result = await db.withTenant(PRACTICE_A, async (sql) => {
      const written = await writeScribeResource(sql, patientInput(id));
      if (!written.ok) throw new Error("write failed");
      throw new Error("injected mid-write failure");
    });
    expect(result.ok).toBe(false);
    expect(await rowCounts(id)).toEqual({ latest: 0, history: 0, inputs: 0 });
  });

  test("write_inputs replay re-derives the canonical FHIR persisted at write time", async () => {
    const id = randomUUID();
    const storedHash = (await writeOk(conditionInput(id, "E11.9"))).record.contentHash;
    const replay = await db.withTenant(PRACTICE_A, async (sql) => {
      const rows = await sql<
        { raw_payload: string }[]
      >`select raw_payload from write_inputs where fhir_resource_id = ${id}`;
      return rows[0]?.raw_payload;
    });
    if (!replay.ok || replay.data === undefined) throw new Error("replay read failed");
    // Re-derive canonical FHIR from the stored raw typed payload — same hash.
    const replayedScribe = fromFhir(toFhir(JSON.parse(replay.data)));
    expect(replayedScribe.ok).toBe(true);
    expect(contentHash(toFhir(JSON.parse(replay.data)))).toBe(storedHash);
  });
});

describe("terminology validate-on-write", () => {
  test("an invalid required-binding code is REJECTED fail-closed (zero rows)", async () => {
    const id = randomUUID();
    const attempt = await writeAttempt(conditionInput(id, "E11.9", "bogus"));
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.error.code).toBe("INVALID_SCRIBE_INPUT");
    expect(await rowCounts(id)).toEqual({ latest: 0, history: 0, inputs: 0 });
  });

  test("an extensible-binding miss is ACCEPTED with an audited warning + pack version", async () => {
    const id = randomUUID();
    const report = (await writeOk(conditionInput(id, "Z99.9"))).terminology;
    expect(report.packVersions[ICD]).toBe("2026");
    expect(report.warnings.some((w) => w.code === "Z99.9")).toBe(true);
    // The write still landed — extensible misses WARN, never block.
    expect((await rowCounts(id)).latest).toBe(1);
  });

  test("an in-pack extensible code produces no warning", async () => {
    const id = randomUUID();
    const report = (await writeOk(conditionInput(id, "E11.9"))).terminology;
    expect(report.warnings).toEqual([]);
    expect(report.packVersions[ICD]).toBe("2026");
  });

  test("a malformed SNOMED code WARNs (format only) but never blocks the write", async () => {
    const id = randomUUID();
    const report = (await writeOk(procedureInput(id, "12345"))).terminology;
    expect(report.warnings.some((w) => w.system === SNOMED)).toBe(true);
    // SNOMED is format-only: no membership query, so no pack version recorded.
    expect(report.packVersions[SNOMED]).toBeUndefined();
    expect((await rowCounts(id)).latest).toBe(1);
  });

  test("a valid SNOMED code produces no SNOMED warning", async () => {
    const id = randomUUID();
    const report = (await writeOk(procedureInput(id, "80146002"))).terminology;
    expect(report.warnings.filter((w) => w.system === SNOMED)).toEqual([]);
  });

  test("validate-on-write makes ZERO network calls", async () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    await writeOk(conditionInput(randomUUID(), "Z99.9"));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("cross-tenant isolation + Consent (dangerCheck: cross-tenant-leak)", () => {
  test("Consent round-trips losslessly and is invisible to another practice", async () => {
    const id = randomUUID();
    const input = consentInput(id);
    await writeOk(input);
    const readA = await db.withTenant(PRACTICE_A, async (sql) => {
      const rows = await sql<
        { content: Record<string, unknown> }[]
      >`select content from fhir_resources where id = ${id}`;
      return rows[0]?.content;
    });
    if (!readA.ok || readA.data === undefined) throw new Error("read A failed");
    const recovered = fromFhir(toJsonObject(readA.data));
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.data).toEqual(input);
    const asB = await db.withTenant(PRACTICE_B, async (sql) => {
      const rows = await sql`select id from fhir_resources where id = ${id}`;
      return rows.length;
    });
    if (!asB.ok) throw new Error("read B failed");
    expect(asB.data).toBe(0);
  });
});

describe("terminology reference data is GLOBAL, SELECT-only", () => {
  test("terminology_concept has no practice_id and bonfire_app cannot write it", async () => {
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'terminology_concept'`;
    expect(columns.map((c) => c.column_name)).not.toContain("practice_id");
    const priv = await sql<{ sel: boolean; ins: boolean; upd: boolean; del: boolean }[]>`
      select has_table_privilege('bonfire_app', 'terminology_concept', 'SELECT') as sel,
             has_table_privilege('bonfire_app', 'terminology_concept', 'INSERT') as ins,
             has_table_privilege('bonfire_app', 'terminology_concept', 'UPDATE') as upd,
             has_table_privilege('bonfire_app', 'terminology_concept', 'DELETE') as del`;
    expect(priv[0]).toEqual({ sel: true, ins: false, upd: false, del: false });
  });
});
