/**
 * Generated-client battery (dangerChecks: cross-tenant-leak, fail-open-authz).
 * Exercises the REAL generated client end to end against the live compose db:
 * scoped search with receipt + audit id, cross-tenant deny-as-empty, typed
 * domain errors that never throw, SDK_UNEXPECTED on an exploding db, and the
 * U2 inversion — a smuggled `subject` in caller input is overwritten by the
 * session's membership-derived subject. All data is synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TenantDb } from "@bonfire/core";
import { connectTenantDb, indexResourceTx, insertFhirResourceTx, ok } from "@bonfire/core";
import type { BonfireSession } from "./auth/session.js";
import { createBonfireClient } from "./generated/client.gen.js";
import { ownerClient, sessionFor } from "./support.test.js";

const SYNTH_SYSTEM = "http://example.org/synthetic";
const QUERY_TERM = "sdkzeta";
const SEED_ATTEMPTS = 3;

const db = connectTenantDb({ max: 4 });
const owner = ownerClient();

const practiceA = randomUUID();
const practiceB = randomUUID();
let clinicianA: BonfireSession;
let clinicianB: BonfireSession;
let billerA: BonfireSession;

/** Insert + index ONE synthetic Condition whose display carries the query term. */
async function seedCondition(practice: string): Promise<string> {
  const id = randomUUID();
  const content = {
    resourceType: "Condition",
    id,
    code: {
      coding: [{ system: SYNTH_SYSTEM, code: "sdk-c1", display: `${QUERY_TERM} hypertension` }],
      text: `${QUERY_TERM} condition`
    },
    clinicalStatus: { coding: [{ code: "active" }] }
  };
  for (let attempt = 1; attempt <= SEED_ATTEMPTS; attempt += 1) {
    const seeded = await db.withTenant(practice, async (sql) => {
      const written = await insertFhirResourceTx(sql, {
        id,
        type: "Condition",
        content,
        rawPayload: JSON.stringify(content)
      });
      if (!written.ok) throw new Error(written.error.code);
      const indexed = await indexResourceTx(sql, id);
      if (!indexed.ok) throw new Error(indexed.error.code);
    });
    if (seeded.ok) return id;
    // withTenant is atomic, so retrying a transient tx conflict cannot double-seed.
    if (seeded.error.code !== "TENANT_TX_FAILED" || attempt === SEED_ATTEMPTS) {
      throw new Error(`condition seed failed: ${seeded.error.code}`);
    }
  }
  return id;
}

/** A structurally valid TenantDb whose tenant path explodes (runOp must absorb it). */
function explodingDb(): TenantDb {
  return {
    withTenant: () => {
      throw new Error("synthetic explosion");
    },
    resolveMembership: () => Promise.resolve(ok(null)),
    end: () => Promise.resolve()
  };
}

beforeAll(async () => {
  [clinicianA, clinicianB, billerA] = (
    await Promise.all([
      sessionFor(db, owner, practiceA, "clinician"),
      sessionFor(db, owner, practiceB, "clinician"),
      sessionFor(db, owner, practiceA, "biller")
    ])
  ).map((seeded) => seeded.session) as [BonfireSession, BonfireSession, BonfireSession];
  await seedCondition(practiceA);
});

afterAll(async () => {
  await Promise.all([db.end(), owner.end()]);
});

describe("createBonfireClient (generated surface over runOp)", () => {
  test("A's clinician finds A's seeded term with receipt + audit id", async () => {
    const client = createBonfireClient(db, clinicianA);
    const found = await client.searchClinical({ query: QUERY_TERM, purposeOfUse: "TREAT" });
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error(found.error.code);
    expect(found.data.results.length).toBeGreaterThan(0);
    expect(found.data.policyReceipt.decision).toBe("allow");
    expect(found.data.policyReceipt.practiceId).toBe(practiceA);
    expect(found.data.auditEventId).toHaveLength(64);
  });

  test("B's clinician searching A's term gets EMPTY ok + receipt (deny is empty, not error)", async () => {
    const client = createBonfireClient(db, clinicianB);
    const found = await client.searchClinical({ query: QUERY_TERM, purposeOfUse: "TREAT" });
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error(found.error.code);
    expect(found.data.results).toHaveLength(0);
    expect(found.data.policyReceipt.practiceId).toBe(practiceB);
    expect(found.data.auditEventId).toHaveLength(64);
  });

  test("malformed propose input -> typed INVALID_SCRIBE_INPUT, never a throw", async () => {
    const client = createBonfireClient(db, clinicianA);
    const written = await client.proposeResource({ resourceType: "Patient" } as never);
    expect(written.ok).toBe(false);
    if (!written.ok) expect(written.error.code).toBe("INVALID_SCRIBE_INPUT");
  });

  test("malformed ccp input -> typed MALFORMED_INPUT, never a throw", async () => {
    const client = createBonfireClient(db, clinicianA);
    const built = await client.buildCcp({
      response: { bogus: true },
      purposeOfUse: "TREAT"
    } as never);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error.code).toBe("MALFORMED_INPUT");
  });

  test("a db that throws mid-call -> err SDK_UNEXPECTED (the boundary never throws)", async () => {
    const client = createBonfireClient(explodingDb(), clinicianA);
    const found = await client.searchClinical({ query: QUERY_TERM, purposeOfUse: "TREAT" });
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.error.code).toBe("SDK_UNEXPECTED");
  });

  test("U2 inversion: a smuggled clinician subject is overwritten by the biller session", async () => {
    const client = createBonfireClient(db, billerA);
    const forged = {
      query: QUERY_TERM,
      purposeOfUse: "TREAT",
      subject: { role: "clinician", id: "attacker", practiceId: practiceA }
    };
    const found = await client.searchClinical(forged as never);
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error(found.error.code);
    // Session-last merge: the effective subject is the biller -> default-deny,
    // zero rows, and the audited actor is the SESSION actor, never "attacker".
    expect(found.data.results).toHaveLength(0);
    expect(found.data.policyReceipt.decision).toBe("deny");
    expect(found.data.policyReceipt.actorId).toBe(billerA.actorId);
  });
});
