/**
 * U2 identity-boundary battery (dangerCheck: fail-open-authz). Every failure
 * shape — verifier deny, missing membership, membership lookup fault, audit
 * append fault — must return a typed deny with a stable code and NEVER yield a
 * session or throw. Success must carry practice/role FROM THE MEMBERSHIP ROW.
 * Hermetic: random practice + subject per test against the live compose db.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TenantDb, Verifier } from "@bonfire/core";
import { connectTenantDb, err, SYSTEM_PRACTICE_ID } from "@bonfire/core";
import { okVerifier, ownerClient, sessionFor, syntheticToken, TEST_ISS } from "../support.test.js";
import { authenticate } from "./session.js";

const db = connectTenantDb({ max: 4 });
const owner = ownerClient();

afterAll(async () => {
  await Promise.all([db.end(), owner.end()]);
});

/** A verifier that denies every token with a stable auth error code. */
const denyingVerifier: Verifier = {
  verifyToken: () => Promise.resolve(err({ code: "TOKEN_EXPIRED", message: "synthetic deny" }))
};

/** Delegate withTenant to the real db but make the membership lookup fault. */
function lookupFaultDb(inner: TenantDb): TenantDb {
  return {
    withTenant: (practiceId, fn) => inner.withTenant(practiceId, fn),
    resolveMembership: () =>
      Promise.resolve(err({ code: "MEMBERSHIP_QUERY_FAILED", message: "synthetic fault" })),
    end: () => inner.end()
  };
}

/** Resolve membership for real, but make every tenant transaction (audit) fail. */
function auditFaultDb(inner: TenantDb): TenantDb {
  return {
    withTenant: () =>
      Promise.resolve(err({ code: "TENANT_TX_FAILED", message: "synthetic tx fault" })),
    resolveMembership: (iss, sub) => inner.resolveMembership(iss, sub),
    end: () => inner.end()
  };
}

describe("authenticate (U2: the only session constructor)", () => {
  test("valid token + seeded membership -> session with practice/role FROM THE ROW", async () => {
    const practice = randomUUID();
    const { session, sub } = await sessionFor(db, owner, practice, "biller");
    expect(session.practiceId).toBe(practice);
    expect(session.role).toBe("biller");
    expect(session.iss).toBe(TEST_ISS);
    expect(session.sub).toBe(sub);
    expect(session.actorId).toBe(`${TEST_ISS}#${sub}`);
  });

  test("verifier deny -> err AUTH_VERIFY_FAILED, never a session", async () => {
    const result = await authenticate({ db, verifier: denyingVerifier, token: syntheticToken() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTH_VERIFY_FAILED");
  });

  test("authenticated but NO membership row -> err AUTH_NO_MEMBERSHIP + SYSTEM deny row", async () => {
    // Unique sub -> unique actor_id (iss#sub), so the SYSTEM chain (shared across
    // suites) can be keyed off actor_id, never a racy global count(*).
    const sub = `ghost-${randomUUID()}`;
    const actorId = `${TEST_ISS}#${sub}`;
    const verifier = okVerifier({ iss: TEST_ISS, sub });
    const result = await authenticate({ db, verifier, token: syntheticToken() });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTH_NO_MEMBERSHIP");
    // Forensic backstop (BF-13 acceptance #7): the deny appended exactly one
    // deny row for this actor on the SYSTEM chain. Reddens if denyAudited stops
    // calling auditAuthFailure — the deny code alone would still pass above.
    const audited = await db.withTenant(
      SYSTEM_PRACTICE_ID,
      (sql) =>
        sql<{ decision: string }[]>`select decision from audit_log where actor_id = ${actorId}`
    );
    expect(audited.ok).toBe(true);
    if (audited.ok) {
      expect(audited.data.length).toBe(1);
      expect(audited.data[0]?.decision).toBe("deny");
    }
  });

  test("membership lookup fault -> err AUTH_MEMBERSHIP_LOOKUP_FAILED, no throw", async () => {
    const verifier = okVerifier({ iss: TEST_ISS, sub: `faulty-${randomUUID()}` });
    const result = await authenticate({
      db: lookupFaultDb(db),
      verifier,
      token: syntheticToken()
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTH_MEMBERSHIP_LOOKUP_FAILED");
  });

  test("success-audit append failure -> err AUTH_AUDIT_FAILED, no session", async () => {
    const practice = randomUUID();
    const sub = `sdk-user-${randomUUID()}`;
    await owner`insert into membership (iss, sub, practice_id, role)
      values (${TEST_ISS}, ${sub}, ${practice}, 'clinician')`;
    const result = await authenticate({
      db: auditFaultDb(db),
      verifier: okVerifier({ iss: TEST_ISS, sub }),
      token: syntheticToken()
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("AUTH_AUDIT_FAILED");
  });
});
