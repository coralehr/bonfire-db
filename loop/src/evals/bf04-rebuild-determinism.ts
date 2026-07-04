/**
 * Execution eval bf04-rebuild-determinism (BF-04 acceptance: projections are
 * a pure function of canonical FHIR).
 *
 * Runs the BUILT rebuild task (`bun run projections:rebuild`) twice and
 * compares per-table content hashes computed HERE with raw SQL — none of the
 * product's dump/hash code — over every vd_% table and spidx (spidx hashed on
 * its logical columns; the identity id is sequence state, not content).
 * Stage-2 coverage no unit test provides: rebuild-determinism.test.ts proves
 * hash-equality using the product's own orderedDumpHash oracle — this eval
 * re-derives the oracle independently, so a bug in the oracle itself cannot
 * vouch for the writer.
 *
 * Inversion: any nondeterminism in the rebuild (row order dependence,
 * now()/random values, drifting numeric rendering) flips the two hash maps
 * apart and goes red.
 *
 * Requires the booted dev stack (migrate + seed), like every DB-backed suite.
 */
import postgres from "postgres";
import { fail, ownerUrl, pass, runArtifact } from "./eval-util.js";

const EVAL_ID = "bf04-rebuild-determinism";

async function hashAllTables(owner: postgres.Sql): Promise<Map<string, string>> {
  const tables = await owner`
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and lower(c.relname) like 'vd\\_%' order by c.relname`;
  const hashes = new Map<string, string>();
  for (const table of tables) {
    const name = String(table.relname);
    const rows = await owner`
      select coalesce(md5(string_agg(md5(t::text), '' order by t::text)), 'empty') as h
      from ${owner(name)} t`;
    hashes.set(name, String(rows[0]?.h));
  }
  // spidx is hashed on its LOGICAL columns: the identity id column is
  // sequence state, not content, and restarts per rebuild.
  const spidx = await owner`
    select coalesce(md5(string_agg(md5(row(practice_id, resource_id, resource_type, param_name,
      param_type, token_system, token_code, ref_value, date_low, date_high)::text), ''
      order by row(practice_id, resource_id, resource_type, param_name, param_type,
      token_system, token_code, ref_value, date_low, date_high)::text)), 'empty') as h
    from spidx`;
  hashes.set("spidx", String(spidx[0]?.h));
  return hashes;
}

function rebuildOnce(): void {
  const run = runArtifact(EVAL_ID, ["bun", "run", "projections:rebuild"]);
  if (run.status !== 0) fail(EVAL_ID, `rebuild exited ${String(run.status)}:\n${run.output}`);
}

const owner = postgres(ownerUrl(), { max: 1, onnotice: () => undefined });
rebuildOnce();
const first = await hashAllTables(owner);
rebuildOnce();
const second = await hashAllTables(owner);
await owner.end({ timeout: 5 });

if (first.size < 2)
  fail(EVAL_ID, `only ${String(first.size)} tables hashed — rebuild produced nothing?`);
for (const [table, hash] of first) {
  const other = second.get(table);
  if (other !== hash) {
    fail(EVAL_ID, `table ${table} drifted across identical rebuilds: ${hash} -> ${String(other)}`);
  }
}
const nonEmpty = [...first.values()].filter((h) => h !== "empty").length;
if (nonEmpty < 1) fail(EVAL_ID, "vacuous: every table hashed empty");
pass(
  EVAL_ID,
  `${String(first.size)} tables byte-stable across two rebuilds (${String(nonEmpty)} non-empty)`
);
