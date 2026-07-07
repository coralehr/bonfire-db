/**
 * TRACER B — membership resolution + authentication audit + pool no-bleed, DB.
 *
 * Runs against the live compose db as bonfire_app. Membership rows are seeded by
 * the OWNER (migrate) client because the app role has REVOKE INSERT (the trust
 * anchor). Every test uses random practice + sub ids, so the append-only chains
 * stay isolated. The SYSTEM chain is shared (failed auth has no tenant), so its
 * per-decision assertions key off the returned row_hash and the genesis-anchored
 * chain, never an absolute count.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { GENESIS_PREV_HASH } from "../audit/row-hash.js";
import { verifyAuditChainTx } from "../audit/verify.js";
import { createSqlClient } from "../db/client.js";
import { devDatabaseUrl, resolveDatabaseTarget } from "../db/env.js";
import type { Membership, TenantSql } from "../db/tenant.js";
import { createTenantDb } from "../db/tenant.js";
import type { AuthFailure } from "./auth-audit.js";
import { auditAuthFailure, auditAuthSuccess, SYSTEM_PRACTICE_ID } from "./auth-audit.js";

const ISS = "https://idp.synthetic.test/";
const CLOCK = (): string => "2026-07-06T12:34:56.789Z";
const DB_TIMEOUT_MS = 30_000;

const db = createTenantDb(createSqlClient(resolveDatabaseTarget(), { max: 5 }));
const owner = createSqlClient({ kind: "url", url: devDatabaseUrl("migrate") }, { max: 1 });
const appRaw = createSqlClient({ kind: "url", url: devDatabaseUrl("app") }, { max: 1 });

async function seedMembership(sub: string, practiceId: string, role: string): Promise<void> {
  await owner`insert into membership (iss, sub, practice_id, role)
    values (${ISS}, ${sub}, ${practiceId}, ${role})`;
}

async function inTenant<T>(practice: string, fn: (sql: TenantSql) => Promise<T>): Promise<T> {
  const result = await db.withTenant(practice, fn);
  if (!result.ok) throw new Error(`withTenant failed: ${result.error.code}`);
  return result.data;
}

/** Rows on the SYSTEM chain whose row_hash is exactly `hash` (hermetic identity).
 *  The SYSTEM chain is shared across suites, so per-decision assertions key off
 *  the returned row_hash, never a global count. */
async function systemRowsByHash(
  hash: string
): Promise<{ actor_id: string; decision: string; reason: string }[]> {
  return inTenant(SYSTEM_PRACTICE_ID, async (sql) => {
    return sql<{ actor_id: string; decision: string; reason: string }[]>`
      select actor_id, decision, reason from audit_log where row_hash = ${hash}`;
  });
}

/** Audit a failure, assert it wrote exactly one SYSTEM-chain row, and return it. */
async function oneSystemDeny(
  failure: AuthFailure,
  clock?: () => string
): Promise<{ actor_id: string; decision: string; reason: string }> {
  const res = clock
    ? await auditAuthFailure(db, failure, clock)
    : await auditAuthFailure(db, failure);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error(`audit failed: ${res.error.code}`);
  const rows = await systemRowsByHash(res.data.auditRowHash);
  expect(rows.length).toBe(1);
  const [row] = rows;
  if (row === undefined) throw new Error("expected exactly one SYSTEM row");
  return row;
}

beforeAll(async () => {
  await verifyChainClean();
});

afterAll(async () => {
  await Promise.all([db.end(), owner.end(), appRaw.end()]);
});

/** The SYSTEM chain must be valid (or empty -> ok) before per-delta assertions. */
async function verifyChainClean(): Promise<void> {
  const report = await inTenant(SYSTEM_PRACTICE_ID, (sql) => verifyAuditChainTx(sql));
  if (!report.ok) throw new Error(`SYSTEM chain is not clean at start: ${report.reason}`);
}

describe("resolveMembership maps (iss,sub) -> practice+role; unseeded denies", () => {
  test(
    "a seeded identity resolves; an unseeded sub yields ok(null) (deny)",
    async () => {
      const practiceId = randomUUID();
      const sub = randomUUID();
      await seedMembership(sub, practiceId, "clinician");
      const hit = await db.resolveMembership(ISS, sub);
      expect(hit.ok).toBe(true);
      if (hit.ok) {
        expect(hit.data?.practiceId).toBe(practiceId);
        expect(hit.data?.role).toBe("clinician");
      }
      const miss = await db.resolveMembership(ISS, randomUUID());
      expect(miss.ok).toBe(true);
      if (miss.ok) expect(miss.data).toBeNull();
    },
    DB_TIMEOUT_MS
  );
});

describe("claims-not-trusted: scope is the membership row, resolved server-side", () => {
  test(
    "the success audit lands under the membership practice, not any token claim",
    async () => {
      // VerifiedIdentity structurally has no practice/role field (compile-time
      // guarantee); the practice comes only from the resolved membership row.
      const membershipPractice = randomUUID();
      const sub = randomUUID();
      await seedMembership(sub, membershipPractice, "biller");
      const resolved = await db.resolveMembership(ISS, sub);
      if (!resolved.ok || resolved.data === null) throw new Error("expected membership");
      await auditAuthSuccess(db, { iss: ISS, sub }, resolved.data, CLOCK);
      const rows = await inTenant(membershipPractice, async (sql) => {
        return sql<
          { practice_id: string }[]
        >`select practice_id::text as practice_id from audit_log`;
      });
      expect(rows.length).toBe(1);
      expect(rows[0]?.practice_id).toBe(membershipPractice);
    },
    DB_TIMEOUT_MS
  );
});

describe("auth success audit: one allow row on the resolved practice's chain", () => {
  test(
    "exactly one allow row, actor ${iss}#${sub}, chain verifies",
    async () => {
      const practiceId = randomUUID();
      const sub = randomUUID();
      const membership: Membership = { practiceId, role: "clinician" };
      const res = await auditAuthSuccess(db, { iss: ISS, sub }, membership, CLOCK);
      expect(res.ok).toBe(true);
      const rows = await inTenant(practiceId, async (sql) => {
        return sql<{ actor_id: string; decision: string }[]>`
          select actor_id, decision from audit_log order by seq asc`;
      });
      expect(rows.length).toBe(1);
      expect(rows[0]?.actor_id).toBe(`${ISS}#${sub}`);
      expect(rows[0]?.decision).toBe("allow");
      const report = await inTenant(practiceId, (sql) => verifyAuditChainTx(sql));
      expect(report.ok).toBe(true);
    },
    DB_TIMEOUT_MS
  );
});

describe("auth failure audit: one deny row on the SYSTEM chain", () => {
  test(
    "a verify failure -> exactly one SYSTEM deny by 'unverified' with reason auth:<code>",
    async () => {
      const row = await oneSystemDeny({ kind: "verify", code: "ALG_NOT_ALLOWED" }, CLOCK);
      expect(row.decision).toBe("deny");
      expect(row.actor_id).toBe("unverified");
      expect(row.reason).toBe("auth: ALG_NOT_ALLOWED");
    },
    DB_TIMEOUT_MS
  );

  test(
    "a no-membership failure -> exactly one SYSTEM deny by the identity; chain from genesis",
    async () => {
      const sub = randomUUID();
      const row = await oneSystemDeny({ kind: "no-membership", identity: { iss: ISS, sub } });
      expect(row.actor_id).toBe(`${ISS}#${sub}`);
      expect(row.decision).toBe("deny");
      expect(row.reason).toBe("auth: no membership");
      // The SYSTEM chain is anchored at genesis and stays valid as it grows.
      const first = await inTenant(SYSTEM_PRACTICE_ID, async (sql) => {
        return sql<
          { prev_hash: string }[]
        >`select prev_hash from audit_log order by seq asc limit 1`;
      });
      expect(first[0]?.prev_hash).toBe(GENESIS_PREV_HASH);
      const report = await inTenant(SYSTEM_PRACTICE_ID, (sql) => verifyAuditChainTx(sql));
      expect(report.ok).toBe(true);
    },
    DB_TIMEOUT_MS
  );
});

describe("SYSTEM chain isolation + membership trust anchor", () => {
  test(
    "a real tenant sees ZERO SYSTEM audit rows (RLS holds)",
    async () => {
      await auditAuthFailure(db, { kind: "verify", code: "VERIFY_FAILED" }, CLOCK);
      const tenant = randomUUID();
      const seen = await inTenant(tenant, async (sql) => {
        return sql`select id from audit_log where practice_id = ${SYSTEM_PRACTICE_ID}`;
      });
      expect(seen.length).toBe(0);
    },
    DB_TIMEOUT_MS
  );

  test(
    "the app role cannot INSERT into membership (trust anchor -> 42501)",
    async () => {
      const rejected = await appRaw`insert into membership (iss, sub, practice_id, role)
        values (${ISS}, ${randomUUID()}, ${randomUUID()}, 'clinician')`.then(
        () => undefined,
        (error: unknown) =>
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : undefined
      );
      expect(rejected).toBe("42501");
    },
    DB_TIMEOUT_MS
  );
});

describe("pool no-bleed at the TenantDb layer (max:1)", () => {
  test(
    "scoped A sees A; a bare reuse of the same connection sees 0; scoped B sees only B",
    async () => {
      const practiceA = randomUUID();
      const practiceB = randomUUID();
      const raw = createSqlClient({ kind: "url", url: devDatabaseUrl("app") }, { max: 1 });
      const single = createTenantDb(raw);
      try {
        await single.withTenant(practiceA, (sql) => {
          return sql`insert into rls_scaffold (practice_id, label)
            values (${practiceA}, 'a1'), (${practiceA}, 'a2')`;
        });
        await single.withTenant(practiceB, (sql) => {
          return sql`insert into rls_scaffold (practice_id, label) values (${practiceB}, 'b1')`;
        });

        const seenA = await single.withTenant(practiceA, (sql) => sql`select id from rls_scaffold`);
        expect(seenA.ok).toBe(true);
        if (seenA.ok) expect(seenA.data.length).toBe(2);

        // Same physical connection, no tenant transaction -> GUC is gone.
        const bare = await raw`select id from rls_scaffold`;
        expect(bare.length).toBe(0);

        const seenB = await single.withTenant(practiceB, (sql) => {
          return sql<
            { practice_id: string }[]
          >`select practice_id::text as practice_id from rls_scaffold`;
        });
        expect(seenB.ok).toBe(true);
        if (seenB.ok) {
          expect(seenB.data.length).toBe(1);
          expect(seenB.data.every((r) => r.practice_id === practiceB)).toBe(true);
        }
      } finally {
        await raw.end();
      }
    },
    DB_TIMEOUT_MS
  );
});
