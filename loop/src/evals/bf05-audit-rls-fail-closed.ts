/**
 * Execution eval bf05-audit-rls-fail-closed (BF-05 danger check:
 * cross-tenant-leak on the audit table itself).
 *
 * Raw app-role TCP client, no product code: with two practices each holding
 * audit rows (written via the independent chain oracle), a session scoped to
 * practice A must see only A's rows and ZERO of B's; a garbage GUC and a
 * missing GUC must each return zero rows WITHOUT erroring open. Probes the
 * live RLS policy exactly as BF-04's projection eval does for vd_*.
 *
 * Inversion: dropping FORCE RLS or the tenant policy on audit_log flips the
 * foreign-row or vacuity check red.
 */
import postgres from "postgres";
import { oracleAppend } from "./bf05-chain-oracle.js";
import { appUrl, fail, pass } from "./eval-util.js";

const EVAL_ID = "bf05-audit-rls-fail-closed";
const CLOCK = "2026-07-06T00:00:00.000Z";
const EXPECTED_OWN_ROWS = 2;

const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });
const practiceA = crypto.randomUUID();
const practiceB = crypto.randomUUID();

function count(rows: readonly unknown[]): number {
  const row = rows[0] as { n: string } | undefined;
  const n = row === undefined ? Number.NaN : Number(row.n);
  if (!Number.isInteger(n)) fail(EVAL_ID, "count query returned a non-integer");
  return n;
}

try {
  await oracleAppend(app, practiceA, "allow", CLOCK);
  await oracleAppend(app, practiceA, "deny", CLOCK);
  await oracleAppend(app, practiceB, "allow", CLOCK);

  const scoped = await app.begin(async (sql) => {
    await sql`select set_config('app.current_practice_id', ${practiceA}, true)`;
    const own = count(await sql`select count(*)::text as n from audit_log`);
    const foreign = count(
      await sql`select count(*)::text as n from audit_log where practice_id <> ${practiceA}::uuid`
    );
    return { own, foreign };
  });
  if (scoped.own !== EXPECTED_OWN_ROWS)
    fail(EVAL_ID, `vacuous: practice A sees ${String(scoped.own)} rows, expected 2`);
  if (scoped.foreign !== 0)
    fail(EVAL_ID, `LEAK: practice A sees ${String(scoped.foreign)} foreign audit rows`);

  const garbage = await app.begin(async (sql) => {
    await sql`select set_config('app.current_practice_id', 'not-a-uuid', true)`;
    return count(await sql`select count(*)::text as n from audit_log`);
  });
  if (garbage !== 0) fail(EVAL_ID, `garbage GUC returned ${String(garbage)} rows, expected 0`);

  const unset = count(await app`select count(*)::text as n from audit_log`);
  if (unset !== 0) fail(EVAL_ID, `missing GUC returned ${String(unset)} rows, expected 0`);

  pass(EVAL_ID, "A sees own=2 foreign=0; garbage/unset GUC=0 without erroring open");
} finally {
  await app.end({ timeout: 5 });
}
