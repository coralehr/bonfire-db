/**
 * DB-backed audit battery (dangerChecks: audit-bypass, cross-tenant-leak,
 * fail-open-authz). Runs against the live compose db as bonfire_app, with an
 * owner client (migrate role) reserved for the tamper eval that elevates past
 * the append-only REVOKE. Practice ids are random per test (audit_log is
 * append-only — no cleanup — so fresh tenants keep counts and seqs exact).
 *
 * The timestamp round-trip test runs FIRST: a clean chain only verifies if the
 * verify-time to_char byte-matches the ISO-8601 written at append time, so that
 * green result is the parity proof every later tamper test relies on.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { PolicyReceipt } from "../abac/types.js";
import { createSqlClient } from "../db/client.js";
import { devDatabaseUrl, resolveDatabaseTarget } from "../db/env.js";
import type { TenantSql } from "../db/tenant.js";
import { createTenantDb } from "../db/tenant.js";
import { appendAuditRowTx, authorizeAndAudit } from "./audit-log.js";
import { verifyAuditChainTx } from "./verify.js";

const CLOCK = (): string => "2026-07-06T12:34:56.789Z";

function receiptFor(practice: string, timestamp: string): PolicyReceipt {
  return {
    decision: "deny",
    actorId: "actor-1",
    resourceType: "Observation",
    practiceId: practice,
    purposeOfUse: "TREAT",
    matchedRuleId: null,
    reason: "deny: test",
    timestamp
  };
}

const appDb = createTenantDb(createSqlClient(resolveDatabaseTarget(), { max: 5 }));
const owner = createSqlClient({ kind: "url", url: devDatabaseUrl("migrate") }, { max: 1 });
const appRaw = createSqlClient({ kind: "url", url: devDatabaseUrl("app") }, { max: 1 });

function allowScope(practice: string): unknown {
  return {
    subject: { id: "clinician-1", role: "clinician", practiceId: practice },
    resource: { resourceType: "Observation", practiceId: practice },
    purposeOfUse: "TREAT",
    requestPracticeId: practice
  };
}

function denyScope(practice: string): unknown {
  return {
    subject: { id: "biller-1", role: "biller", practiceId: practice },
    resource: { resourceType: "Observation", practiceId: practice },
    purposeOfUse: "HPAYMT",
    requestPracticeId: practice
  };
}

async function inTenant<T>(practice: string, fn: (sql: TenantSql) => Promise<T>): Promise<T> {
  const result = await appDb.withTenant(practice, fn);
  if (!result.ok) throw new Error(`withTenant failed: ${result.error.code}`);
  return result.data;
}

/** The seq column of the current tenant's chain in numeric (audit_log.seq) order. */
async function chainSeqs(practice: string): Promise<string[]> {
  return inTenant(practice, async (sql) => {
    const rows = await sql<{ seq: string }[]>`
      select seq::text as seq from audit_log order by audit_log.seq asc`;
    return rows.map((r) => r.seq);
  });
}

/** Append the standard allow/deny/allow 3-row chain for a fresh practice. */
async function appendThree(practice: string): Promise<void> {
  await inTenant(practice, async (sql) => {
    await authorizeAndAudit(sql, allowScope(practice), CLOCK);
    await authorizeAndAudit(sql, denyScope(practice), CLOCK);
    await authorizeAndAudit(sql, allowScope(practice), CLOCK);
  });
}

async function auditRowCount(tenant: string): Promise<number | undefined> {
  return await inTenant(tenant, async (sql) => {
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from audit_log`;
    return rows[0]?.n;
  });
}

function pgCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const { code } = error;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

async function attemptAsApp(
  practice: string,
  run: (tx: TransactionSql) => Promise<unknown>
): Promise<string | undefined> {
  try {
    await appRaw.begin(async (tx) => {
      await tx`select set_config('app.current_practice_id', ${practice}, true)`;
      await run(tx);
    });
    return undefined;
  } catch (error) {
    return pgCode(error);
  }
}

afterAll(async () => {
  await Promise.all([appDb.end(), owner.end(), appRaw.end()]);
});

describe("append + verify round-trip", () => {
  test("a clean 3-row chain verifies OK (timestamp parity holds)", async () => {
    const practice = randomUUID();
    await appendThree(practice);
    const report = await inTenant(practice, (sql) => verifyAuditChainTx(sql));
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.rows).toBe(3);
  });

  test("appendAuditRowTx returns the row_hash that is persisted", async () => {
    const practice = randomUUID();
    const { receipt, auditRowHash } = await inTenant(practice, (sql) =>
      authorizeAndAudit(sql, allowScope(practice), CLOCK)
    );
    const stored = await inTenant(practice, async (sql) => {
      const rows = await sql<{ row_hash: string; purpose_of_use: string; decision: string }[]>`
        select row_hash, purpose_of_use, decision from audit_log order by seq asc`;
      return rows;
    });
    expect(stored.length).toBe(1);
    expect(stored[0]?.row_hash).toBe(auditRowHash);
    expect(stored[0]?.purpose_of_use).toBe(receipt.purposeOfUse);
    expect(stored[0]?.decision).toBe(receipt.decision);
  });
});

describe("audit-no-read-without-receipt: exactly one row per decision", () => {
  test("an allow AND a deny each emit exactly one audit row (never zero, never dup)", async () => {
    const practice = randomUUID();
    const allow = await inTenant(practice, (sql) =>
      authorizeAndAudit(sql, allowScope(practice), CLOCK)
    );
    expect(allow.receipt.decision).toBe("allow");
    const afterAllow = await inTenant(practice, async (sql) => {
      const rows = await sql<{ n: number }[]>`select count(*)::int as n from audit_log`;
      return rows[0]?.n;
    });
    expect(afterAllow).toBe(1);

    const deny = await inTenant(practice, (sql) =>
      authorizeAndAudit(sql, denyScope(practice), CLOCK)
    );
    expect(deny.receipt.decision).toBe("deny");
    const afterDeny = await inTenant(practice, async (sql) => {
      const rows = await sql<{ decision: string; seq: string }[]>`
        select decision, seq::text as seq from audit_log order by audit_log.seq asc`;
      return rows;
    });
    expect(afterDeny.length).toBe(2);
    expect(afterDeny.map((r) => r.decision)).toEqual(["allow", "deny"]);
  });

  test("a denied MALFORMED read still audits with sentinel purpose (no divergence)", async () => {
    const practice = randomUUID();
    const { receipt } = await inTenant(practice, (sql) => authorizeAndAudit(sql, {}, CLOCK));
    expect(receipt.decision).toBe("deny");
    expect(receipt.purposeOfUse).toBe("unknown");
    const stored = await inTenant(practice, async (sql) => {
      const rows = await sql<{ decision: string; purpose_of_use: string }[]>`
        select decision, purpose_of_use from audit_log`;
      return rows;
    });
    expect(stored.length).toBe(1);
    expect(stored[0]?.decision).toBe("deny");
    expect(stored[0]?.purpose_of_use).toBe("unknown");
  });
});

describe("audit input boundary guards", () => {
  test("a receipt whose practice differs from the bound tenant is refused (mis-attribution)", async () => {
    const tenant = randomUUID();
    const otherPractice = randomUUID();
    const result = await appDb.withTenant(tenant, (sql) =>
      appendAuditRowTx(sql, receiptFor(otherPractice, "2026-07-06T00:00:00.000Z"))
    );
    // The throw rolls the tenant tx back → withTenant returns a typed err.
    expect(result.ok).toBe(false);
    expect(await auditRowCount(tenant)).toBe(0);
  });

  test("a non-canonical timestamp is refused fail-closed (ISO-8601 ms UTC only)", async () => {
    const tenant = randomUUID();
    for (const bad of ["2026-07-06T00:00:00Z", "2026-07-06T05:30:00.000+05:30", "not-a-date"]) {
      const result = await appDb.withTenant(tenant, (sql) =>
        appendAuditRowTx(sql, receiptFor(tenant, bad))
      );
      expect(result.ok).toBe(false);
    }
    expect(await auditRowCount(tenant)).toBe(0);
  });

  test("verifying a session whose GUC folds to null is refused, not vacuously clean", async () => {
    // A garbage GUC folds to null (safe_uuid), RLS hides every row, and an
    // unguarded verify would read ok/rows:0. It must throw instead.
    let thrown: string | undefined;
    try {
      await appRaw.begin(async (tx) => {
        await tx`select set_config('app.current_practice_id', 'not-a-uuid', true)`;
        return await verifyAuditChainTx(tx);
      });
    } catch (error) {
      thrown = String(error);
    }
    expect(thrown).toContain("bound practice context");
  });
});

describe("append-only at the DB layer", () => {
  test("app UPDATE and DELETE on audit_log both fail with 42501 (privilege revoked)", async () => {
    const practice = randomUUID();
    await inTenant(practice, (sql) => authorizeAndAudit(sql, allowScope(practice), CLOCK));
    expect(await attemptAsApp(practice, (tx) => tx`update audit_log set reason = 'x'`)).toBe(
      "42501"
    );
    expect(await attemptAsApp(practice, (tx) => tx`delete from audit_log`)).toBe("42501");
  });

  test("the product path (withTenant) surfaces an UPDATE as a typed TENANT_TX_FAILED", async () => {
    const practice = randomUUID();
    await inTenant(practice, (sql) => authorizeAndAudit(sql, allowScope(practice), CLOCK));
    const upd = await appDb.withTenant(practice, async (sql) => {
      await sql`update audit_log set reason = 'x'`;
      return true;
    });
    expect(upd.ok).toBe(false);
    if (!upd.ok) expect(upd.error.code).toBe("TENANT_TX_FAILED");
  });
});

describe("tamper detection under elevated privilege", () => {
  test("owner-mutated committed row → verify flags the exact index; restore → OK", async () => {
    const practice = randomUUID();
    const receipts = await inTenant(practice, async (sql) => {
      const a = await authorizeAndAudit(sql, allowScope(practice), CLOCK);
      const b = await authorizeAndAudit(sql, denyScope(practice), CLOCK);
      const c = await authorizeAndAudit(sql, allowScope(practice), CLOCK);
      return [a.receipt, b.receipt, c.receipt];
    });
    const clean = await inTenant(practice, (sql) => verifyAuditChainTx(sql));
    expect(clean.ok).toBe(true);

    // Elevate past the append-only REVOKE and silently edit row 2 (seq 2).
    await owner`update audit_log set reason = 'SILENTLY EDITED'
      where practice_id = ${practice} and seq = 2`;
    const tampered = await inTenant(practice, (sql) => verifyAuditChainTx(sql));
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) {
      expect(tampered.reason).toBe("row_hash_mismatch");
      expect(tampered.brokenIndex).toBe(1);
      expect(tampered.brokenSeq).toBe("2");
    }

    // Restore the original reason → the chain verifies clean again.
    await owner`update audit_log set reason = ${receipts[1]!.reason}
      where practice_id = ${practice} and seq = 2`;
    const restored = await inTenant(practice, (sql) => verifyAuditChainTx(sql));
    expect(restored.ok).toBe(true);
  });

  test("owner-deleted tip's predecessor → verify flags a seq_gap", async () => {
    const practice = randomUUID();
    await appendThree(practice);
    await owner`delete from audit_log where practice_id = ${practice} and seq = 2`;
    const report = await inTenant(practice, (sql) => verifyAuditChainTx(sql));
    if (report.ok) throw new Error("deleting seq 2 must break the chain with a seq_gap");
    expect(report.reason).toBe("seq_gap");
    expect(report.brokenIndex).toBe(1);
    expect(report.brokenSeq).toBe("3");
  });
});

describe("RLS fail-closed on audit_log", () => {
  test("cross-practice read: B sees zero of A's audit rows; no-GUC bare read is empty", async () => {
    const practiceA = randomUUID();
    const practiceB = randomUUID();
    const a = await inTenant(practiceA, (sql) =>
      authorizeAndAudit(sql, allowScope(practiceA), CLOCK)
    );
    await inTenant(practiceB, (sql) => authorizeAndAudit(sql, allowScope(practiceB), CLOCK));

    const asA = await inTenant(practiceA, async (sql) => {
      const rows = await sql<{ practice_id: string }[]>`select practice_id::text from audit_log`;
      return rows;
    });
    expect(asA.length).toBe(1);
    expect(asA.every((r) => r.practice_id === practiceA)).toBe(true);

    const bSeesA = await inTenant(practiceB, async (sql) => {
      const rows = await sql`select id from audit_log where row_hash = ${a.auditRowHash}`;
      return rows.length;
    });
    expect(bSeesA).toBe(0);

    const bare = await appRaw`select id from audit_log`;
    expect(bare.length).toBe(0);
  });
});

describe("concurrent appends do not fork the chain", () => {
  test("two concurrent authorizeAndAudit for one practice → seqs 1,2 and a valid chain", async () => {
    const practice = randomUUID();
    const [r1, r2] = await Promise.all([
      inTenant(practice, (sql) => authorizeAndAudit(sql, allowScope(practice), CLOCK)),
      inTenant(practice, (sql) => authorizeAndAudit(sql, denyScope(practice), CLOCK))
    ]);
    expect(r1.auditRowHash).not.toBe(r2.auditRowHash);
    const seqs = await chainSeqs(practice);
    expect(seqs).toEqual(["1", "2"]);
    const report = await inTenant(practice, (sql) => verifyAuditChainTx(sql));
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.rows).toBe(2);
  });
});

describe("direct appendAuditRowTx seam", () => {
  test("appendAuditRowTx chains from GENESIS for the first row of a fresh practice", async () => {
    const practice = randomUUID();
    const first = await inTenant(practice, (sql) =>
      appendAuditRowTx(sql, {
        decision: "deny",
        actorId: "op-1",
        resourceType: "Observation",
        practiceId: practice,
        purposeOfUse: "HOPERAT",
        matchedRuleId: null,
        reason: "deny: no matching allow rule",
        timestamp: "2026-07-06T12:34:56.789Z"
      })
    );
    const stored = await inTenant(practice, async (sql) => {
      const rows = await sql<{ prev_hash: string; seq: string }[]>`
        select prev_hash, seq::text as seq from audit_log order by audit_log.seq asc`;
      return rows;
    });
    expect(stored.length).toBe(1);
    expect(stored[0]?.seq).toBe("1");
    expect(stored[0]?.prev_hash).toBe(
      "40c830dd17cd0878cb29288c881f77e1c581a4dc40ab784552ad309f8260978c"
    );
    expect(first.auditRowHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// BP-033 regression: the tip read + verify read project `seq::text as seq`, so an
// UNQUALIFIED `order by seq` binds to that TEXT alias and sorts lexicographically
// (…,"8","9","10","2"). At >=10 rows that makes the tip read return "9" as the max
// (append collides on seq=10 and the chain STICKS), and makes verify see a false
// seq_gap. A fresh-stack CI run never accumulates 10 rows in one chain, so only a
// chain that deliberately crosses 10 catches it. Both reads are now qualified
// (order by audit_log.seq); this test fails fast if that qualification regresses.
describe("BP-033: a chain past 10 rows appends contiguously and verifies", () => {
  const CHAIN_LENGTH = 12;
  test("twelve sequential appends stay seq 1..12 (numeric, not lexicographic) and verify ok", async () => {
    const practice = randomUUID();
    const hashes: string[] = [];
    for (let i = 0; i < CHAIN_LENGTH; i += 1) {
      // A lexicographic tip read would return "9" as the max at >=10 rows,
      // recompute seq=10, collide on the existing seq-10 row, and throw here.
      const res = await inTenant(practice, (sql) =>
        appendAuditRowTx(sql, receiptFor(practice, CLOCK()))
      );
      hashes.push(res.auditRowHash);
    }
    expect(new Set(hashes).size).toBe(CHAIN_LENGTH);
    const seqs = await chainSeqs(practice);
    expect(seqs).toEqual(Array.from({ length: CHAIN_LENGTH }, (_, i) => String(i + 1)));
    const report = await inTenant(practice, (sql) => verifyAuditChainTx(sql));
    expect(report.ok).toBe(true);
    if (report.ok) expect(report.rows).toBe(CHAIN_LENGTH);
  });
});
