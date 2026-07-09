/**
 * Execution eval bf02-tenant-id-namespace (closes ratchet BP-019,
 * unique-constraint-existence-oracle).
 *
 * Postgres PK/UNIQUE/FK enforcement bypasses RLS BY DESIGN (the docs call it a
 * covert channel): with a global PK, a tenant inserting its own chosen resource
 * id got a distinguishable 23505 whenever that id existed in ANY other practice
 * — a cross-tenant id-existence probe + id-squatting DoS. The fix is tenant-
 * scoped identity (migration 0010): every uniqueness scope on a client-
 * influenceable value leads with practice_id, so each practice is its own FHIR
 * logical-id namespace and the probe transfers ZERO bits (it just succeeds).
 *
 * Layer 1 (behavioral, via the real product write path across the firewall):
 * practice A inserts id X; practice B inserting the SAME id X succeeds exactly
 * like any fresh insert (indistinguishable), each side reads only its own row,
 * and a same-tenant duplicate still legitimately fails.
 *
 * Layer 2 (structural, catalog-wide, self-maintaining): the oracle exists only
 * where the app role can attempt the insert that probes the constraint, so we
 * scope to FORCE-RLS tables that GRANT INSERT to bonfire_app (owner-only-write
 * directories like `membership` — a deliberate global identity map with INSERT
 * revoked — have no client probe surface and are exempt by property). On those
 * tables, every unique index must include practice_id — unless every key column
 * is server-generated (identity column or a gen_random_uuid() default), which a
 * client can never supply. Derived by property, not by name: a future table or a
 * "helpful" re-added global UNIQUE turns this red automatically.
 *
 * Inversion: `create unique index ... on write_inputs (fhir_resource_id)` (the
 * pre-0010 shape) -> structural layer red; reverting 0010's composite PK ->
 * behavioral layer red (B's probe 23505s again).
 */
import postgres from "postgres";
import { fail, ownerUrl, pass, runArtifact } from "./eval-util.js";

const EVAL_ID = "bf02-tenant-id-namespace";
const DEMO = "scripts/search-demo/run.ts";

function seedOne(practice: string, id: string, family: string): number {
  const doc = {
    id,
    type: "Patient",
    content: { resourceType: "Patient", id, name: [{ family }] }
  };
  const run = runArtifact(EVAL_ID, [
    "bun",
    DEMO,
    JSON.stringify({ cmd: "seed", practice, corpus: [doc] })
  ]);
  return run.status ?? 1;
}

// --- Layer 1: behavioral indistinguishability through the product write path ---
const practiceA = crypto.randomUUID();
const practiceB = crypto.randomUUID();
const sharedId = crypto.randomUUID();

if (seedOne(practiceA, sharedId, "Namespace901") !== 0) {
  fail(EVAL_ID, "practice A's initial insert failed");
}
const probe = seedOne(practiceB, sharedId, "Namespace902");
if (probe !== 0) {
  fail(
    EVAL_ID,
    `EXISTENCE ORACLE: practice B inserting practice A's id failed (exit ${String(probe)}) — the probe leaked that the id exists`
  );
}
const fresh = seedOne(practiceB, crypto.randomUUID(), "Namespace903");
if (fresh !== 0) fail(EVAL_ID, "control failed: practice B's fresh-id insert failed");
const dup = seedOne(practiceB, sharedId, "Namespace904");
if (dup === 0) fail(EVAL_ID, "same-tenant duplicate id unexpectedly succeeded (uniqueness lost)");

// --- Layer 2: structural — tenant-scoped uniqueness on every FORCE-RLS table ---
const owner = postgres(ownerUrl(), { max: 1, onnotice: () => undefined });
try {
  const rows = await owner`
    select c.relname as table_name, i.relname as index_name,
      array_agg(a.attname order by k.ord) as key_columns,
      bool_and(a.attidentity <> '' or coalesce(pg_get_expr(ad.adbin, ad.adrelid), '') like '%gen_random_uuid%')
        as all_server_generated
    from pg_index x
    join pg_class c on c.oid = x.indrelid
    join pg_class i on i.oid = x.indexrelid
    cross join lateral unnest(x.indkey[0:x.indnkeyatts-1]) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
    left join pg_attrdef ad on ad.adrelid = c.oid and ad.adnum = a.attnum
    where x.indisunique and c.relforcerowsecurity
      and has_table_privilege('bonfire_app', c.oid, 'INSERT')
    group by c.relname, i.relname`;
  interface IndexRow {
    readonly table_name: string;
    readonly index_name: string;
    readonly key_columns: readonly string[];
    readonly all_server_generated: boolean;
  }
  const offenders = (rows as unknown as IndexRow[]).filter(
    (r) => !r.key_columns.includes("practice_id") && !r.all_server_generated
  );
  if (offenders.length > 0) {
    fail(
      EVAL_ID,
      `cross-tenant uniqueness scope(s) on FORCE-RLS table(s) — an existence oracle: ${offenders
        .map((o) => `${o.table_name}.${o.index_name}(${o.key_columns.join(",")})`)
        .join("; ")}`
    );
  }
  const audited = (rows as unknown as IndexRow[]).length;
  pass(
    EVAL_ID,
    `probe transferred zero bits (cross-tenant same-id insert succeeds; same-tenant dup fails); ${String(audited)} unique indexes on FORCE-RLS tables all tenant-scoped or server-generated`
  );
} finally {
  await owner.end({ timeout: 5 });
}
