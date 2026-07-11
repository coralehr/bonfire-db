/**
 * BF-02 RLS fail-closed battery for the FHIR store tables
 * (dangerChecks: cross-tenant-leak, fail-open-authz).
 *
 * Runs against the live compose db AFTER `bun run db:migrate`, as bonfire_app.
 * Every deny path asserts ZERO ROWS — never all rows, never an error read as
 * deny. Practice ids are random per run: history/write_inputs are append-only
 * (no cleanup possible by design), so fresh tenants keep every count exact.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createSqlClient } from "./client.js";
import { resolveDatabaseTarget } from "./env.js";
import { insertFhirResourceTx } from "./fhir-store.js";
import { createTenantDb } from "./tenant.js";

const PRACTICE_A = randomUUID();
const PRACTICE_B = randomUUID();
const FHIR_TABLES = ["fhir_resources", "history", "write_inputs", "seed_completions"] as const;
const APPEND_ONLY_TABLES = ["history", "write_inputs", "seed_completions"] as const;
const A_MARKER = `rls-test-marker-${PRACTICE_A}`;
const A_IDS = [randomUUID(), randomUUID()];
const B_ID = randomUUID();

const sql = createSqlClient(resolveDatabaseTarget(), { max: 1 });
const db = createTenantDb(sql);

interface CatalogColumn {
  table_name: string;
  column_name: string;
  is_nullable: string;
  data_type: string;
}

interface RlsPosture {
  relname: string;
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
}

function patient(id: string, family: string) {
  return {
    id,
    type: "Patient",
    content: { resourceType: "Patient", id, name: [{ family }] },
    rawPayload: JSON.stringify({ resourceType: "Patient", id })
  };
}

async function seedPatient(practiceId: string, id: string, family: string): Promise<void> {
  const result = await db.withTenant(practiceId, async (sql) =>
    insertFhirResourceTx(sql, patient(id, family))
  );
  if (!result.ok || !result.data.ok) throw new Error(`seedPatient failed for ${id}`);
}

async function countVisible(practiceId: string, table: string): Promise<number> {
  const result = await db.withTenant(practiceId, async (sql) => {
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`;
    return rows[0]?.n;
  });
  if (!result.ok || result.data === undefined) throw new Error(`countVisible failed on ${table}`);
  return result.data;
}

beforeAll(async () => {
  await seedPatient(PRACTICE_A, A_IDS[0]!, "TenantAlpha101");
  await seedPatient(PRACTICE_A, A_IDS[1]!, "TenantAlpha102");
  await seedPatient(PRACTICE_B, B_ID, "TenantBravo201");
  const marker = await db.withTenant(PRACTICE_A, async (sql) => {
    await sql`insert into seed_completions (practice_id, manifest_hash)
      values (${PRACTICE_A}, ${A_MARKER})`;
    return true;
  });
  expect(marker.ok).toBe(true);
});

afterAll(async () => {
  await db.end();
});

describe("schema catalog", () => {
  test("schema catalog: four tables, practice_id NOT NULL, content jsonb", async () => {
    const columns = await sql<CatalogColumn[]>`
      select table_name, column_name, is_nullable, data_type
      from information_schema.columns
      where table_schema = 'public'
        and table_name = any(${[...FHIR_TABLES]})
        and column_name in ('practice_id', 'content')`;
    for (const table of FHIR_TABLES) {
      const practiceId = columns.find(
        (c) => c.table_name === table && c.column_name === "practice_id"
      );
      expect(practiceId?.is_nullable).toBe("NO");
      expect(practiceId?.data_type).toBe("uuid");
    }
    const content = columns.find(
      (c) => c.table_name === "fhir_resources" && c.column_name === "content"
    );
    expect(content?.data_type).toBe("jsonb");
    expect(content?.is_nullable).toBe("NO");
  });

  test("content rows are jsonb documents, never double-encoded string scalars", async () => {
    // Guard for the double-encoding regression class: interpolating a
    // stringified document and casting it to jsonb stores a jsonb STRING
    // scalar through postgres.js, silently corrupting every content row.
    // Only sql.json() writes a real document; this must yield 'object'.
    const result = await db.withTenant(PRACTICE_A, async (sql) => {
      const rows = await sql<{ t: string }[]>`
        select distinct jsonb_typeof(content) as t from fhir_resources
        union
        select distinct jsonb_typeof(content) as t from history`;
      return [...rows];
    });
    if (!result.ok) throw new Error("withTenant failed");
    expect(result.data).toEqual([{ t: "object" }]);
  });

  test("RLS enabled and forced on all four tables", async () => {
    const rows = await sql<RlsPosture[]>`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class where relname = any(${[...FHIR_TABLES]})`;
    expect(rows.length).toBe(FHIR_TABLES.length);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  test("bonfire_app NOSUPERUSER NOBYPASSRLS", async () => {
    const [role] = await sql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolbypassrls from pg_roles where rolname = 'bonfire_app'`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  test("append-only grants: no UPDATE/DELETE on the three immutable tables", async () => {
    for (const table of APPEND_ONLY_TABLES) {
      const rows = await sql<{ upd: boolean; del: boolean; ins: boolean; sel: boolean }[]>`
        select has_table_privilege('bonfire_app', ${table}, 'UPDATE') as upd,
               has_table_privilege('bonfire_app', ${table}, 'DELETE') as del,
               has_table_privilege('bonfire_app', ${table}, 'INSERT') as ins,
               has_table_privilege('bonfire_app', ${table}, 'SELECT') as sel`;
      expect(rows[0]?.upd).toBe(false);
      expect(rows[0]?.del).toBe(false);
      expect(rows[0]?.ins).toBe(true);
      expect(rows[0]?.sel).toBe(true);
    }
    const latest = await sql<{ upd: boolean; del: boolean }[]>`
      select has_table_privilege('bonfire_app', 'fhir_resources', 'UPDATE') as upd,
             has_table_privilege('bonfire_app', 'fhir_resources', 'DELETE') as del`;
    expect(latest[0]?.upd).toBe(true);
    expect(latest[0]?.del).toBe(true);
  });

  // BP-018 catalog posture matrix: the initdb default privilege is now
  // SELECT,INSERT-only, so append-only is opt-out -> opt-in. This pins the
  // posture in BOTH directions — a regression that re-grants U/D on an
  // append-only table OR strips it from a mutable one fails here. The audit
  // table (BF-05) is on the append-only list; the mutable positive controls
  // prove the explicit grants (0002/0004/0006 + the vd_* DDL generator) fire.
  test("BP-018 posture: append-only, read-only, and mutable tables each hold", async () => {
    const priv = async (table: string) => {
      const [row] = await sql<{ upd: boolean; del: boolean; ins: boolean; sel: boolean }[]>`
        select has_table_privilege('bonfire_app', ${table}, 'UPDATE') as upd,
               has_table_privilege('bonfire_app', ${table}, 'DELETE') as del,
               has_table_privilege('bonfire_app', ${table}, 'INSERT') as ins,
               has_table_privilege('bonfire_app', ${table}, 'SELECT') as sel`;
      return row;
    };
    // Append-only: S/I, never U/D. Includes the new BF-05 audit_log and the
    // three BF-09 governance tables (0012): event-sourced governance has no
    // UPDATE path at the privilege layer, which is what makes a committed
    // signed note structurally immutable rather than app-logic immutable.
    for (const table of [
      "history",
      "write_inputs",
      "seed_completions",
      "audit_log",
      "governance_proposal",
      "governance_event",
      "governance_signed_note"
    ]) {
      expect(await priv(table)).toEqual({ upd: false, del: false, ins: true, sel: true });
    }
    // Reference data: read-only for the app (loader writes as owner). The
    // membership directory (BF-13) is on this list as the trust anchor: the app
    // may SELECT (resolve identity->practice) but NEVER INSERT/UPDATE/DELETE —
    // if it could self-provision a row it could self-assign any practice_id +
    // role (a total ABAC bypass). This pins the 0008 REVOKE INSERT structurally,
    // so a regression that re-grants write on membership fails HERE.
    for (const table of ["terminology_pack", "terminology_concept", "membership"]) {
      expect(await priv(table)).toEqual({ upd: false, del: false, ins: false, sel: true });
    }
    // Mutable positive controls: the explicit grants must give U/D, or the
    // BP-018 flip would silently break the write path (rls_scaffold cleanup,
    // spidx/vd_* projection upsert, fhir_resources versioning). vd_* is
    // included so a regression in the ddl.ts runtime grant is caught at the
    // posture pin, not only behaviourally when the projection upsert breaks.
    // (vd_patient_demographics exists after the boot chain's projections:rebuild.)
    for (const table of ["fhir_resources", "spidx", "rls_scaffold", "vd_patient_demographics"]) {
      const p = await priv(table);
      expect(p?.upd).toBe(true);
      expect(p?.del).toBe(true);
    }
  });
});

describe("fail-closed default-deny", () => {
  test("no GUC → zero rows on every table", async () => {
    // Positive control first: the tenant sees its own rows, so the zero-row
    // assertions below cannot pass vacuously on empty tables.
    for (const table of FHIR_TABLES) {
      expect(await countVisible(PRACTICE_A, table)).toBeGreaterThan(0);
    }
    for (const table of FHIR_TABLES) {
      const bare = await sql`select practice_id from ${sql(table)}`;
      expect(bare.length).toBe(0);
    }
  });

  test("garbage GUC → zero rows, never an error (BP-014)", async () => {
    for (const table of FHIR_TABLES) {
      const rows = await sql.begin(async (sql) => {
        await sql`select set_config('app.current_practice_id', 'not-a-uuid-at-all', true)`;
        return sql`select practice_id from ${sql(table)}`;
      });
      expect(rows.length).toBe(0);
    }
  });

  test("empty GUC → zero rows on every table", async () => {
    for (const table of FHIR_TABLES) {
      const rows = await sql.begin(async (sql) => {
        await sql`select set_config('app.current_practice_id', '', true)`;
        return sql`select practice_id from ${sql(table)}`;
      });
      expect(rows.length).toBe(0);
    }
  });

  test("no-GUC UPDATE/DELETE affect zero rows", async () => {
    const updated = await sql`update fhir_resources set last_updated = now()`;
    expect(updated.count).toBe(0);
    const deleted = await sql`delete from fhir_resources`;
    expect(deleted.count).toBe(0);
    // Positive control: the rows still exist for their own tenant.
    expect(await countVisible(PRACTICE_A, "fhir_resources")).toBe(A_IDS.length);
  });
});

describe("cross-tenant isolation", () => {
  test("practice B sees/updates/deletes zero of A's rows", async () => {
    const aId = A_IDS[0]!;
    const asB = await db.withTenant(PRACTICE_B, async (sql) => {
      const selected = await sql`select id from fhir_resources where id = ${aId}`;
      const history = await sql`select id from history where id = ${aId}`;
      const inputs = await sql`select id from write_inputs where fhir_resource_id = ${aId}`;
      const markers = await sql`select id from seed_completions where manifest_hash = ${A_MARKER}`;
      const updated = await sql`update fhir_resources set last_updated = now() where id = ${aId}`;
      const deleted = await sql`delete from fhir_resources where id = ${aId}`;
      return {
        selected: selected.length,
        history: history.length,
        inputs: inputs.length,
        markers: markers.length,
        updated: updated.count,
        deleted: deleted.count
      };
    });
    if (!asB.ok) throw new Error("withTenant(B) failed");
    expect(asB.data).toEqual({
      selected: 0,
      history: 0,
      inputs: 0,
      markers: 0,
      updated: 0,
      deleted: 0
    });
    // Positive control: A still sees both of its rows.
    expect(await countVisible(PRACTICE_A, "fhir_resources")).toBe(A_IDS.length);
    expect(await countVisible(PRACTICE_B, "fhir_resources")).toBe(1);
  });

  test("WITH CHECK denies smuggling a practice-B row from a practice-A session", async () => {
    const smuggleId = randomUUID();
    const content = { resourceType: "Patient", id: smuggleId };
    const result = await db.withTenant(PRACTICE_A, async (sql) => {
      await sql`insert into fhir_resources (id, type, practice_id, version_id, last_updated, content)
        values (${smuggleId}, 'Patient', ${PRACTICE_B}, 1, now(), ${sql.json(content)})`;
      return true;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TENANT_TX_FAILED");
    const asB = await db.withTenant(PRACTICE_B, async (sql) => {
      const rows = await sql`select id from fhir_resources where id = ${smuggleId}`;
      return rows.length;
    });
    if (!asB.ok) throw new Error("withTenant(B) failed");
    expect(asB.data).toBe(0);
  });

  test("pool no-bleed: bare query after withTenant (same max:1 pool) sees ZERO rows", async () => {
    expect(await countVisible(PRACTICE_A, "fhir_resources")).toBe(A_IDS.length);
    const bare = await sql`select id from fhir_resources`;
    expect(bare.length).toBe(0);
  });
});
