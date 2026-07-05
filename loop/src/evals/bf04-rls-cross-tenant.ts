/**
 * Execution eval bf04-rls-cross-tenant (BF-04 danger check: cross-tenant-leak).
 *
 * Connects to the LIVE stack as the runtime bonfire_app role over TCP — a raw
 * postgres client, none of the product's connection/tenant code — and proves
 * the stamped policies on the projection read surface: scoped to practice A,
 * vd_patient_demographics and spidx return ZERO rows of any other practice;
 * a garbage GUC and a missing GUC each fold to zero rows without erroring
 * open. Stage-2 coverage no unit test provides: the DB-backed tests exercise
 * RLS through @bonfire/core's withTenant wiring — this eval removes that
 * layer entirely, so a regression hiding in the product client cannot mask a
 * policy regression (and vice versa).
 *
 * Inversion: dropping FORCE RLS, widening a policy, or granting BYPASSRLS to
 * bonfire_app leaks rows (or a garbage GUC starts erroring) and goes red.
 *
 * Requires the booted dev stack (migrate + seed + projections:rebuild), like
 * every DB-backed suite in the repo.
 */
import postgres from "postgres";
import { appUrl, fail, ownerUrl, pass } from "./eval-util.js";

const EVAL_ID = "bf04-rls-cross-tenant";
const MIN_PRACTICES = 2;

const owner = postgres(ownerUrl(), { max: 1, onnotice: () => undefined });
const app = postgres(appUrl(), { max: 1, onnotice: () => undefined });

interface CountRow {
  n: string;
}

function count(rows: readonly unknown[]): number {
  const row = rows[0] as CountRow | undefined;
  const n = row === undefined ? Number.NaN : Number(row.n);
  // Fail-closed: NaN silently skips `<` comparisons, so refuse it here.
  if (!Number.isInteger(n)) fail(EVAL_ID, "count query returned a non-integer — aliasing drift?");
  return n;
}

const practices = await owner`
  select practice_id::text as practice_id, count(*)::int as rows
  from vd_patient_demographics group by practice_id order by practice_id`;
const spidxPractices = count(await owner`select count(distinct practice_id)::text as n from spidx`);
if (practices.length < MIN_PRACTICES || spidxPractices < MIN_PRACTICES) {
  await owner.end({ timeout: 5 });
  await app.end({ timeout: 5 });
  fail(
    EVAL_ID,
    `need >= ${String(MIN_PRACTICES)} seeded practices in vd_patient_demographics (found ${String(practices.length)}) AND spidx (found ${String(spidxPractices)}) — boot order (seed + projections:rebuild) missing?`
  );
}
const practiceA = String(practices[0]?.practice_id);

const scoped = await app.begin(async (sql) => {
  await sql`select set_config('app.current_practice_id', ${practiceA}, true)`;
  const own = count(await sql`select count(*)::text as n from vd_patient_demographics`);
  const ownSpidx = count(await sql`select count(*)::text as n from spidx`);
  const foreignVd = count(
    await sql`select count(*)::text as n from vd_patient_demographics where practice_id <> ${practiceA}::uuid`
  );
  const foreignSpidx = count(
    await sql`select count(*)::text as n from spidx where practice_id <> ${practiceA}::uuid`
  );
  return { own, ownSpidx, foreignVd, foreignSpidx };
});
const garbage = await app.begin(async (sql) => {
  await sql`select set_config('app.current_practice_id', 'not-a-uuid-at-all', true)`;
  return count(await sql`select count(*)::text as n from vd_patient_demographics`);
});
const unset = count(await app`select count(*)::text as n from vd_patient_demographics`);

await owner.end({ timeout: 5 });
await app.end({ timeout: 5 });

if (scoped.own < 1) fail(EVAL_ID, "vacuous: practice A sees zero of its own vd rows");
if (scoped.ownSpidx < 1) fail(EVAL_ID, "vacuous: practice A sees zero of its own spidx rows");
if (scoped.foreignVd !== 0 || scoped.foreignSpidx !== 0) {
  fail(
    EVAL_ID,
    `LEAK: practice A sees foreign rows (vd=${String(scoped.foreignVd)}, spidx=${String(scoped.foreignSpidx)})`
  );
}
if (garbage !== 0) fail(EVAL_ID, `garbage GUC returned ${String(garbage)} rows, expected 0`);
if (unset !== 0) fail(EVAL_ID, `missing GUC returned ${String(unset)} rows, expected 0`);
pass(
  EVAL_ID,
  `raw app-role probe: own=${String(scoped.own)}, foreign vd/spidx=0, garbage/unset GUC=0`
);
