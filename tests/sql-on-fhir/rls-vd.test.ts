/**
 * Tracer B — dynamically created vd_* projections and spidx are fail-closed
 * RLS surfaces (cross-tenant-leak danger check): practice A reads ZERO of
 * practice B's rows on every SQL path, garbage/empty tenant context yields
 * zero rows without erroring open, and the catalog invariant + event-trigger
 * ratchet hold for EVERY vd_%/spidx relation.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TestContext, TwoPracticeSetup } from "./helpers.js";
import { appSql, closeContext, setupTwoPractices } from "./helpers.js";

let s: TwoPracticeSetup;
let ctx: TestContext;

beforeAll(async () => {
  s = await setupTwoPractices({ rebuildFirst: true });
  ctx = s.ctx;
});

afterAll(async () => {
  await closeContext(ctx);
});

describe("vd_* cross-tenant isolation", () => {
  test("practice A reads its own patient row and ZERO of practice B's", async () => {
    const rows = await ctx.db.withTenant(s.practiceA, async (sql) => {
      return await sql`select id from vd_patient_demographics`;
    });
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    const ids = rows.data.map((row) => String(row.id));
    expect(ids).toContain(s.corpusA.patientId);
    expect(ids).not.toContain(s.corpusB.patientId);
  });

  test("a direct key probe for B's row as A returns zero rows (no existence oracle)", async () => {
    const rows = await ctx.db.withTenant(s.practiceA, async (sql) => {
      return await sql`select id from vd_patient_demographics where id = ${s.corpusB.patientId}`;
    });
    expect(rows.ok).toBe(true);
    if (rows.ok) expect(rows.data.length).toBe(0);
  });

  test("spidx as practice A never returns B's rows (token probe on B's MRN)", async () => {
    const rows = await ctx.db.withTenant(s.practiceA, async (sql) => {
      return await sql`select resource_id from spidx where token_code = ${s.corpusB.mrn}`;
    });
    expect(rows.ok).toBe(true);
    if (rows.ok) expect(rows.data.length).toBe(0);
    // The same probe scoped to B (owner oracle) proves the row exists at all.
    const oracle = await ctx.owner`
      select resource_id from spidx
      where token_code = ${s.corpusB.mrn} and practice_id = ${s.practiceB}`;
    expect(oracle.length).toBe(1);
  });
});

describe("fail-closed tenant context", () => {
  const VD_PROBE_TABLES = ["vd_patient_demographics", "vd_observation_summary", "spidx"];

  test("garbage GUC yields ZERO rows and no error on vd_* and spidx", async () => {
    const app = appSql();
    try {
      for (const table of VD_PROBE_TABLES) {
        const rows = await app.begin(async (sql) => {
          await sql`select set_config('app.current_practice_id', 'not-a-uuid', true)`;
          return await sql`select * from ${sql(table)}`;
        });
        expect(rows.length).toBe(0);
      }
    } finally {
      await app.end({ timeout: 5 });
    }
  });

  test("empty/unset GUC yields ZERO rows and no error on vd_* and spidx", async () => {
    const app = appSql();
    try {
      for (const table of VD_PROBE_TABLES) {
        const rows = await app`select * from ${app(table)}`;
        expect(rows.length).toBe(0);
      }
    } finally {
      await app.end({ timeout: 5 });
    }
  });
});

describe("event-trigger ratchet (belt-and-braces for forgotten RLS)", () => {
  test("a bare owner-created vd_ table is force-stamped and unreadable cross-tenant", async () => {
    await ctx.owner`drop table if exists vd_evil_probe`;
    await ctx.owner`create table vd_evil_probe (practice_id uuid not null, secret text)`;
    try {
      await ctx.owner`insert into vd_evil_probe (practice_id, secret) values (${s.practiceB}::uuid, 'b-only')`;
      const stamped = await ctx.owner`
        select relrowsecurity, relforcerowsecurity from pg_class
        where relname = 'vd_evil_probe'`;
      expect(stamped[0]?.relrowsecurity).toBe(true);
      expect(stamped[0]?.relforcerowsecurity).toBe(true);
      const policies = await ctx.owner`
        select policyname from pg_policies where tablename = 'vd_evil_probe'`;
      expect(policies.length).toBe(1);
      const asA = await ctx.db.withTenant(s.practiceA, async (sql) => {
        return await sql`select * from vd_evil_probe`;
      });
      expect(asA.ok).toBe(true);
      if (asA.ok) expect(asA.data.length).toBe(0);
    } finally {
      // Drop inside the same test so the catalog sweep below sees only real tables.
      await ctx.owner`drop table if exists vd_evil_probe`;
    }
  });
});

describe("catalog invariant (MANDATORY structural control)", () => {
  test("every vd_%/spidx relation is ENABLE+FORCE RLS with exactly one safe_uuid policy for bonfire_app", async () => {
    const relations = await ctx.owner`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and (c.relname like 'vd\\_%' or c.relname like 'spidx%')`;
    expect(relations.length).toBeGreaterThanOrEqual(9);
    for (const relation of relations) {
      expect(relation.relrowsecurity).toBe(true);
      expect(relation.relforcerowsecurity).toBe(true);
      const policies = await ctx.owner`
        select polname, roles, qual, with_check from (
          select p.polname,
                 array(select rolname from pg_roles r where r.oid = any(p.polroles)) as roles,
                 pg_get_expr(p.polqual, p.polrelid) as qual,
                 pg_get_expr(p.polwithcheck, p.polrelid) as with_check
          from pg_policy p
          join pg_class c on c.oid = p.polrelid
          where c.relname = ${String(relation.relname)}
        ) x`;
      expect(policies.length).toBe(1);
      const policy = policies[0];
      if (policy === undefined) continue;
      const guard = "safe_uuid(current_setting('app.current_practice_id'";
      expect(String(policy.qual)).toContain(guard);
      expect(String(policy.with_check)).toContain(guard);
      expect(policy.roles).toEqual(["bonfire_app"]);
    }
  });

  test("the runtime role can never bypass RLS (not super, not BYPASSRLS)", async () => {
    const roles = await ctx.owner`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'bonfire_app'`;
    expect(roles[0]?.rolsuper).toBe(false);
    expect(roles[0]?.rolbypassrls).toBe(false);
  });
});
