/**
 * scripts/auth-demo/pooled-probe.ts — drive the PRODUCT tenant boundary
 * (connectTenantDb().withTenant) over a max:1 pool so the bf13-pool-no-bleed
 * eval can prove no context bleeds across pooled-connection checkouts (BP-005).
 *
 * max:1 forces every withTenant onto the SAME physical connection. Request A
 * runs and commits — its transaction-local GUC dies with the transaction — then
 * request B runs on that reused connection. Each inserts into rls_scaffold and
 * counts what RLS lets it see; B seeing ONLY its own rows (never A's) is the
 * no-bleed proof that the eval asserts.
 *
 * argv: <practiceA> <practiceB> <nA> <nB>. stdout: {"aCount":n,"bCount":n}.
 */

import type { TenantSql } from "../../packages/core/src/index.js";
import { connectTenantDb } from "../../packages/core/src/index.js";

async function seedAndCount(sql: TenantSql, practice: string, rows: number): Promise<number> {
  for (let i = 0; i < rows; i += 1) {
    await sql`insert into rls_scaffold (practice_id, label)
      values (${practice}::uuid, ${`bf13-${String(i)}`})`;
  }
  const counted = await sql<{ n: number }[]>`select count(*)::int as n from rls_scaffold`;
  return counted[0]?.n ?? 0;
}

async function main(): Promise<number> {
  const [practiceA, practiceB, nA, nB] = process.argv.slice(2);
  if (practiceA === undefined || practiceB === undefined || nA === undefined || nB === undefined) {
    process.stderr.write("usage: pooled-probe.ts <practiceA> <practiceB> <nA> <nB>\n");
    return 1;
  }
  const db = connectTenantDb({ max: 1 });
  try {
    const a = await db.withTenant(practiceA, (sql) => seedAndCount(sql, practiceA, Number(nA)));
    const b = await db.withTenant(practiceB, (sql) => seedAndCount(sql, practiceB, Number(nB)));
    if (!a.ok || !b.ok) {
      process.stderr.write(`withTenant failed: a=${JSON.stringify(a)} b=${JSON.stringify(b)}\n`);
      return 1;
    }
    process.stdout.write(`${JSON.stringify({ aCount: a.data, bCount: b.data })}\n`);
    return 0;
  } finally {
    await db.end();
  }
}

process.exitCode = await main();
