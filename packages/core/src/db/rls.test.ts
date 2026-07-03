/**
 * BF-01 RLS fail-closed battery (dangerChecks: cross-tenant-leak, fail-open-authz).
 *
 * Runs against the live compose db AFTER `bun run db:migrate`, connecting as the
 * runtime role bonfire_app via the synthetic dev-default URL (or DATABASE_URL).
 * Every deny path asserts ZERO ROWS — never all rows, never a thrown error read
 * as allow. The single max:1 pool makes the no-bleed test airtight: the bare
 * query is guaranteed to reuse the exact physical connection withTenant used.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSqlClient } from "./client.js";
import { resolveDatabaseTarget } from "./env.js";
import { createTenantDb } from "./tenant.js";

const PRACTICE_A = "00000000-0000-4000-8000-00000000000a";
const PRACTICE_B = "00000000-0000-4000-8000-00000000000b";
const PG18_VERSION_NUM = 180000;

const sql = createSqlClient(resolveDatabaseTarget(), { max: 1 });
const db = createTenantDb(sql);

interface ScaffoldRow {
  id: string;
  practice_id: string;
  label: string;
}

async function tenantRows(practiceId: string): Promise<ScaffoldRow[]> {
  const result = await db.withTenant(practiceId, async (tx) => {
    const rows = await tx<ScaffoldRow[]>`select id, practice_id, label from rls_scaffold`;
    return [...rows];
  });
  if (!result.ok) throw new Error(`withTenant failed: ${result.error.code}`);
  return result.data;
}

beforeAll(async () => {
  // Idempotent cleanup + seed, all through withTenant (RLS scopes the deletes).
  for (const practice of [PRACTICE_A, PRACTICE_B]) {
    const cleaned = await db.withTenant(practice, async (tx) => {
      await tx`delete from rls_scaffold`;
      return true;
    });
    expect(cleaned.ok).toBe(true);
  }
  const seededA = await db.withTenant(PRACTICE_A, async (tx) => {
    await tx`insert into rls_scaffold (practice_id, label) values
      (${PRACTICE_A}, 'a-row-1'), (${PRACTICE_A}, 'a-row-2')`;
    return true;
  });
  const seededB = await db.withTenant(PRACTICE_B, async (tx) => {
    await tx`insert into rls_scaffold (practice_id, label) values (${PRACTICE_B}, 'b-row-1')`;
    return true;
  });
  expect(seededA.ok).toBe(true);
  expect(seededB.ok).toBe(true);
});

afterAll(async () => {
  await db.end();
});

describe("rls_scaffold fail-closed default-deny", () => {
  test("no practice GUC -> SELECT returns ZERO rows (not all rows, not an error)", async () => {
    const rows = await sql`select id from rls_scaffold`;
    expect(rows.length).toBe(0);
  });

  test("empty-string GUC -> ZERO rows via NULLIF (fail-closed, no cast error)", async () => {
    const rows = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_practice_id', '', true)`;
      return tx`select id from rls_scaffold`;
    });
    expect(rows.length).toBe(0);
  });

  test("a garbage practice context yields zero rows, never an error (BP-014)", async () => {
    const rows = await sql.begin(async (tx) => {
      await tx`select set_config('app.current_practice_id', 'definitely-not-a-uuid', true)`;
      return tx`select id from rls_scaffold`;
    });
    expect(rows.length).toBe(0);
  });

  test("withTenant rejects a non-UUID practice id with a typed error (Zod boundary)", async () => {
    const result = await db.withTenant("", async () => true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_PRACTICE_ID");
  });

  test("cross-tenant isolation: practice A sees only A rows, zero of B's", async () => {
    const rowsA = await tenantRows(PRACTICE_A);
    expect(rowsA.length).toBe(2);
    expect(rowsA.every((row) => row.practice_id === PRACTICE_A)).toBe(true);
    expect(rowsA.some((row) => row.label.startsWith("b-"))).toBe(false);

    const rowsB = await tenantRows(PRACTICE_B);
    expect(rowsB.length).toBe(1);
    expect(rowsB.every((row) => row.practice_id === PRACTICE_B)).toBe(true);
  });

  test("WITH CHECK denies writing another practice's row (typed error, no throw)", async () => {
    const result = await db.withTenant(PRACTICE_A, async (tx) => {
      await tx`insert into rls_scaffold (practice_id, label) values (${PRACTICE_B}, 'smuggled')`;
      return true;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TENANT_TX_FAILED");
    const rowsB = await tenantRows(PRACTICE_B);
    expect(rowsB.some((row) => row.label === "smuggled")).toBe(false);
  });

  test("pool no-bleed: bare query after withTenant (same max:1 pool) sees ZERO rows", async () => {
    const scoped = await tenantRows(PRACTICE_A);
    expect(scoped.length).toBe(2);
    const bare = await sql`select id from rls_scaffold`;
    expect(bare.length).toBe(0);
  });
});

describe("catalog guards (role + table posture)", () => {
  test("runtime role bonfire_app is NOSUPERUSER and NOBYPASSRLS", async () => {
    const rows = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'bonfire_app'`;
    expect(rows.length).toBe(1);
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  test("rls_scaffold has RLS ENABLED and FORCEd (owner is subject to RLS too)", async () => {
    const rows = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class where relname = 'rls_scaffold'`;
    expect(rows.length).toBe(1);
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  test("pgvector extension is installed", async () => {
    const rows = await sql<{ extversion: string }[]>`
      select extversion from pg_extension where extname = 'vector'`;
    expect(rows.length).toBe(1);
  });

  test("Postgres major version is 18+", async () => {
    const rows = await sql<{ v: string }[]>`select current_setting('server_version_num') as v`;
    expect(Number(rows[0]?.v)).toBeGreaterThanOrEqual(PG18_VERSION_NUM);
  });
});
