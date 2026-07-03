/**
 * BF-02 atomic write path: fhir_resources + history + write_inputs commit or
 * roll back together inside one withTenant transaction.
 *
 * Rollback is proven TWICE (server-side SQLSTATE 23503/23505 + client-side
 * throw), each followed by fresh-session zero-row assertions and a pool-health
 * query (the connection must come back usable, not leaked mid-transaction).
 * Practice id is random per run: history/write_inputs are append-only by
 * design, so fresh tenants keep every count exact without cleanup.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { contentHash } from "./canonical-json.js";
import { createSqlClient } from "./client.js";
import { resolveDatabaseTarget } from "./env.js";
import { insertFhirResourceTx, updateFhirResourceTx } from "./fhir-store.js";
import { createTenantDb } from "./tenant.js";

const PRACTICE = randomUUID();

const sql = createSqlClient(resolveDatabaseTarget(), { max: 1 });
const db = createTenantDb(sql);

interface VersionRow {
  version_id: string;
  content: { name?: { family: string }[] };
}

// Extracted so the version-history test stays under the complexity cap: every
// optional-chain link counts as a branch in the enclosing function.
function rowSummary(row: VersionRow | undefined) {
  return { version: row?.version_id, family: row?.content.name?.[0]?.family };
}

function patientInput(id: string, family: string) {
  const content = { resourceType: "Patient", id, name: [{ family }] };
  return { id, type: "Patient", content, rawPayload: JSON.stringify(content) };
}

function sqlStateOf(cause: unknown): string | undefined {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = cause.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

async function rowCounts(id: string): Promise<{ latest: number; history: number; inputs: number }> {
  const result = await db.withTenant(PRACTICE, async (sql) => {
    const latest = await sql`select id from fhir_resources where id = ${id}`;
    const history = await sql`select id from history where id = ${id}`;
    const inputs = await sql`select id from write_inputs where fhir_resource_id = ${id}`;
    return { latest: latest.length, history: history.length, inputs: inputs.length };
  });
  if (!result.ok) throw new Error("rowCounts failed");
  return result.data;
}

async function createPatient(id: string, family: string) {
  const created = await db.withTenant(PRACTICE, async (sql) =>
    insertFhirResourceTx(sql, patientInput(id, family))
  );
  if (!created.ok) throw new Error("withTenant failed on create");
  return created.data;
}

async function expectPoolHealthy(): Promise<void> {
  const health = await sql`select 1 as one`;
  expect(health.length).toBe(1);
}

afterAll(async () => {
  await db.end();
});

describe("one atomic write path", () => {
  test("create writes fhir_resources + history(v1) + write_inputs in one transaction", async () => {
    const id = randomUUID();
    const created = await createPatient(id, "Atomic301");
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.versionId).toBe("1");
    expect(created.data.practiceId).toBe(PRACTICE);
    expect(await rowCounts(id)).toEqual({ latest: 1, history: 1, inputs: 1 });
  });

  test("server-side constraint abort leaves zero rows (23505/23503)", async () => {
    const id = randomUUID();
    let fkState: string | undefined;
    const result = await db.withTenant(PRACTICE, async (sql) => {
      const first = await insertFhirResourceTx(sql, patientInput(id, "Rollback401"));
      if (!first.ok) throw new Error("setup insert failed");
      try {
        // Dangling FK: write_inputs must reference an existing fhir_resources
        // row — this is the migration's constraint, asserted by SQLSTATE.
        await sql`insert into write_inputs (practice_id, fhir_resource_id, raw_payload)
          values (${PRACTICE}, ${randomUUID()}, 'dangling-payload')`;
      } catch (cause) {
        fkState = sqlStateOf(cause);
        throw cause;
      }
      return true;
    });
    expect(result.ok).toBe(false);
    expect(fkState).toBe("23503");
    // The FULLY SUCCESSFUL first write rolled back with the failed statement.
    expect(await rowCounts(id)).toEqual({ latest: 0, history: 0, inputs: 0 });
    await expectPoolHealthy();
  });

  test("duplicate history version is rejected by PK (id, version_id) (23505)", async () => {
    const id = randomUUID();
    const content = { resourceType: "Patient", id };
    let dupState: string | undefined;
    const result = await db.withTenant(PRACTICE, async (sql) => {
      const first = await insertFhirResourceTx(sql, patientInput(id, "Duplicate501"));
      if (!first.ok) throw new Error("setup insert failed");
      try {
        await sql`insert into history (id, version_id, type, practice_id, content, content_hash, last_updated)
          values (${id}, 1, 'Patient', ${PRACTICE}, ${sql.json(content)}, 'dup-hash', now())`;
      } catch (cause) {
        dupState = sqlStateOf(cause);
        throw cause;
      }
      return true;
    });
    expect(result.ok).toBe(false);
    expect(dupState).toBe("23505");
    expect(await rowCounts(id)).toEqual({ latest: 0, history: 0, inputs: 0 });
    await expectPoolHealthy();
  });

  test("callback throw rolls back all three tables", async () => {
    const id = randomUUID();
    const result = await db.withTenant(PRACTICE, async (sql) => {
      const first = await insertFhirResourceTx(sql, patientInput(id, "Injected601"));
      if (!first.ok) throw new Error("setup insert failed");
      throw new Error("injected mid-write failure");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TENANT_TX_FAILED");
    expect(await rowCounts(id)).toEqual({ latest: 0, history: 0, inputs: 0 });
    await expectPoolHealthy();
  });
});

describe("history append-only", () => {
  test("update appends v2, v1 content untouched", async () => {
    const id = randomUUID();
    const created = await createPatient(id, "VersionOne701");
    expect(created.ok).toBe(true);
    const updatedContent = { resourceType: "Patient", id, name: [{ family: "VersionTwo702" }] };
    const updated = await db.withTenant(PRACTICE, async (sql) =>
      updateFhirResourceTx(sql, { id, content: updatedContent, expectedVersionId: "1" })
    );
    if (!updated.ok) throw new Error("withTenant failed on update");
    expect(updated.data.ok).toBe(true);
    if (updated.data.ok) expect(updated.data.data.versionId).toBe("2");

    const state = await db.withTenant(PRACTICE, async (sql) => {
      const versions = await sql<VersionRow[]>`
        select version_id::text as version_id, content
        from history where id = ${id} order by version_id`;
      const latest = await sql<VersionRow[]>`
        select version_id::text as version_id, content from fhir_resources where id = ${id}`;
      const inputs = await sql`select id from write_inputs where fhir_resource_id = ${id}`;
      return { versions: [...versions], latest: [...latest], inputs: inputs.length };
    });
    if (!state.ok) throw new Error("withTenant failed reading state");
    expect(state.data.versions.length).toBe(2);
    expect(rowSummary(state.data.versions[0])).toEqual({ version: "1", family: "VersionOne701" });
    expect(rowSummary(state.data.versions[1])).toEqual({ version: "2", family: "VersionTwo702" });
    expect(rowSummary(state.data.latest[0])).toEqual({ version: "2", family: "VersionTwo702" });
    // write_inputs is written on create only: still exactly one payload.
    expect(state.data.inputs).toBe(1);
  });

  test("stale expectedVersionId yields VERSION_CONFLICT and writes nothing", async () => {
    const id = randomUUID();
    await createPatient(id, "Stale801");
    const conflicted = await db.withTenant(PRACTICE, async (sql) =>
      updateFhirResourceTx(sql, {
        id,
        content: { resourceType: "Patient", id },
        expectedVersionId: "99"
      })
    );
    if (!conflicted.ok) throw new Error("withTenant failed");
    expect(conflicted.data.ok).toBe(false);
    if (!conflicted.data.ok) expect(conflicted.data.error.code).toBe("VERSION_CONFLICT");
    expect(await rowCounts(id)).toEqual({ latest: 1, history: 1, inputs: 1 });
  });

  test("UPDATE on history is permission-denied", async () => {
    const id = randomUUID();
    await createPatient(id, "Tamper901");
    let denyState: string | undefined;
    const result = await db.withTenant(PRACTICE, async (sql) => {
      try {
        await sql`update history set content_hash = 'tampered' where id = ${id}`;
      } catch (cause) {
        denyState = sqlStateOf(cause);
        throw cause;
      }
      return true;
    });
    expect(result.ok).toBe(false);
    expect(denyState).toBe("42501");
    await expectPoolHealthy();
  });

  test("DELETE on history and write_inputs is permission-denied", async () => {
    const id = randomUUID();
    await createPatient(id, "Immutable902");
    for (const statement of ["history", "write_inputs"] as const) {
      let denyState: string | undefined;
      const result = await db.withTenant(PRACTICE, async (sql) => {
        try {
          if (statement === "history") {
            await sql`delete from history where id = ${id}`;
          } else {
            await sql`delete from write_inputs where fhir_resource_id = ${id}`;
          }
        } catch (cause) {
          denyState = sqlStateOf(cause);
          throw cause;
        }
        return true;
      });
      expect(result.ok).toBe(false);
      expect(denyState).toBe("42501");
    }
    expect(await rowCounts(id)).toEqual({ latest: 1, history: 1, inputs: 1 });
  });
});

describe("write_inputs replay parity", () => {
  test("raw_payload round-trips byte-identical", async () => {
    const id = randomUUID();
    const rawPayload = `{ "resourceType":"Patient",\t"id":"${id}" , "note": "  spacing preserved  " }`;
    const created = await db.withTenant(PRACTICE, async (sql) =>
      insertFhirResourceTx(sql, {
        id,
        type: "Patient",
        content: { resourceType: "Patient", id },
        rawPayload
      })
    );
    if (!created.ok || !created.data.ok) throw new Error("create failed");
    const readBack = await db.withTenant(PRACTICE, async (sql) => {
      const rows = await sql<{ raw_payload: string }[]>`
        select raw_payload from write_inputs where fhir_resource_id = ${id}`;
      return rows[0]?.raw_payload;
    });
    if (!readBack.ok) throw new Error("read-back failed");
    expect(readBack.data).toBe(rawPayload);
  });

  test("insert→read-back→re-canonicalize→hash matches", async () => {
    const id = randomUUID();
    const content = {
      resourceType: "Observation",
      id,
      status: "final",
      code: { coding: [{ system: "http://loinc.org", code: "29463-7" }] },
      valueQuantity: { value: 72.6, unit: "kg" },
      note: [{ text: "unicode-safe: éàß✓" }]
    };
    const created = await db.withTenant(PRACTICE, async (sql) =>
      insertFhirResourceTx(sql, {
        id,
        type: "Observation",
        content,
        rawPayload: JSON.stringify(content)
      })
    );
    if (!created.ok || !created.data.ok) throw new Error("create failed");
    const storedHash = created.data.data.contentHash;

    const readBack = await db.withTenant(PRACTICE, async (sql) => {
      const rows = await sql<{ content: Record<string, unknown>; content_hash: string }[]>`
        select content, content_hash from history where id = ${id}`;
      return rows[0];
    });
    if (!readBack.ok || readBack.data === undefined) throw new Error("read-back failed");
    expect(readBack.data.content_hash).toBe(storedHash);
    // jsonb re-orders keys internally; the canonical hash must not care.
    expect(contentHash(readBack.data.content)).toBe(storedHash);
  });
});
