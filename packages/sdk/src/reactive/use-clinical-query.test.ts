/**
 * U3 reactivity battery (dangerCheck: cross-tenant-leak). Integration against
 * the live compose db with the 0011 NOTIFY triggers: same-practice updates
 * emit a fresh snapshot within the 2s budget; another practice's identical
 * update provably triggers the re-query but the content diff SUPPRESSES the
 * emission; a spoofed NOTIFY is a harmless re-query; a rolled-back write
 * (at-commit delivery) emits nothing; a non-whitelisted view fails closed with
 * zero SQL and zero LISTENs. All rows are synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TenantDb } from "@bonfire/core";
import { connectTenantDb, devDatabaseUrl } from "@bonfire/core";
import postgres from "postgres";
import type { BonfireSession } from "../auth/session.js";
import { ownerClient, sessionFor } from "../support.test.js";
import type { ClinicalQueryStore } from "./use-clinical-query.js";
import { useClinicalQuery } from "./use-clinical-query.js";
import { CLINICAL_VIEWS } from "./views.js";

const VIEW = "vd_patient_demographics";
const EMIT_BUDGET_MS = 2000;
const QUIET_WINDOW_MS = 1500;

const db = connectTenantDb({ max: 4 });
const owner = ownerClient();
// The ONE physical listen connection, shared by every store in this file.
const listenClient = postgres(devDatabaseUrl("app"), { max: 1 });

const practiceA = randomUUID();
const practiceB = randomUUID();
let sessionA: BonfireSession;

/** Count every tenant transaction so tests can prove a re-query RAN. */
function countingDb(inner: TenantDb, counter: { queries: number }): TenantDb {
  return {
    withTenant: (practiceId, fn) => {
      counter.queries += 1;
      return inner.withTenant(practiceId, fn);
    },
    resolveMembership: (iss, sub) => inner.resolveMembership(iss, sub),
    end: () => inner.end()
  };
}

/** Insert one synthetic demographics row; `abort` forces a rollback mid-tx. */
async function insertDemographic(
  practice: string,
  family: string,
  abort = false
): Promise<boolean> {
  const outcome = await db.withTenant(practice, async (sql) => {
    await sql`insert into vd_patient_demographics
      (practice_id, row_index, version_id, last_updated, id, gender, family_name)
      values (${practice}, 0, 1, now(), ${randomUUID()}, 'other', ${family})`;
    if (abort) throw new Error("force rollback");
  });
  if (!outcome.ok && !abort) throw new Error(`vd seed failed: ${outcome.error.code}`);
  return outcome.ok;
}

/** Resolve true on the next emission, false if `timeoutMs` passes quietly. */
function nextEmission(store: ClinicalQueryStore, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let unsubscribe = (): void => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    unsubscribe = store.subscribe(() => {
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

/** Open a store for session A and wait for its initial snapshot emission. */
async function openStore(dbHandle: TenantDb): Promise<ClinicalQueryStore> {
  const created = useClinicalQuery(sessionA, dbHandle, listenClient, { view: VIEW });
  if (!created.ok) throw new Error(created.error.code);
  const first = await nextEmission(created.data, EMIT_BUDGET_MS);
  if (!first) throw new Error("store produced no initial snapshot");
  return created.data;
}

beforeAll(async () => {
  const trigger = await db.withTenant(practiceA, (sql) => {
    return sql`select tgname from pg_trigger where tgname = ${`${VIEW}_notify`}`;
  });
  if (!trigger.ok || trigger.data.length === 0) {
    throw new Error("vd_* notify trigger missing — run `bun run db:migrate` (prep 0011)");
  }
  sessionA = (await sessionFor(db, owner, practiceA, "clinician")).session;
  await insertDemographic(practiceA, "Baseline");
});

afterAll(async () => {
  await Promise.all([db.end(), owner.end(), listenClient.end()]);
});

describe("useClinicalQuery (LISTEN/NOTIFY, tenant-scoped)", () => {
  test("whitelist stays a subset of the materialized vd_* catalog", async () => {
    const catalog = await db.withTenant(practiceA, (sql) => {
      return sql`select relname from pg_class
        where relname ~ '^vd_' and relkind in ('r', 'p')`;
    });
    if (!catalog.ok) throw new Error(catalog.error.code);
    const materialized = new Set(catalog.data.map((row) => row.relname));
    for (const view of CLINICAL_VIEWS) expect(materialized.has(view)).toBe(true);
  });

  test("every whitelisted view carries the (id, row_index) total order loadRows assumes", async () => {
    // loadRows orders EVERY view by (id, row_index). A view missing either
    // column would error -> the store keeps a stale snapshot forever (fail-safe,
    // never cross-tenant, but silently non-reactive). Only one view is exercised
    // end-to-end below, so pin the column convention for all eight here.
    const ordered = await db.withTenant(practiceA, (sql) => {
      return sql<{ table_name: string; column_name: string }[]>`
        select table_name, column_name from information_schema.columns
        where table_schema = 'public'
          and table_name = any(${[...CLINICAL_VIEWS]}::text[])
          and column_name in ('id', 'row_index')`;
    });
    if (!ordered.ok) throw new Error(ordered.error.code);
    const columnsByView = new Map<string, Set<string>>();
    for (const row of ordered.data) {
      const seen = columnsByView.get(row.table_name) ?? new Set<string>();
      seen.add(row.column_name);
      columnsByView.set(row.table_name, seen);
    }
    for (const view of CLINICAL_VIEWS) {
      expect([...(columnsByView.get(view) ?? [])].sort()).toEqual(["id", "row_index"]);
    }
  });

  test("same-practice update emits a fresh snapshot within 2s", async () => {
    const store = await openStore(db);
    const family = `Fresh${randomUUID().slice(0, 8)}`;
    const emitted = nextEmission(store, EMIT_BUDGET_MS);
    await insertDemographic(practiceA, family);
    expect(await emitted).toBe(true);
    const snapshot = store.getSnapshot();
    expect(snapshot?.rows.some((row) => row.family_name === family)).toBe(true);
    await store.close();
  });

  test("another practice's update: re-query RUNS, emission is SUPPRESSED", async () => {
    const counter = { queries: 0 };
    const store = await openStore(countingDb(db, counter));
    const queriesBefore = counter.queries;
    const emitted = nextEmission(store, QUIET_WINDOW_MS);
    await insertDemographic(practiceB, "CrossTenant");
    expect(await emitted).toBe(false);
    // The wake-up reached A's store (shared channel, one physical connection)
    // and its scoped re-query ran — the content diff is what suppressed it.
    expect(counter.queries).toBeGreaterThan(queriesBefore);
    await store.close();
  });

  test("spoofed NOTIFY payload: harmless re-query, no emission", async () => {
    const counter = { queries: 0 };
    const store = await openStore(countingDb(db, counter));
    const queriesBefore = counter.queries;
    const emitted = nextEmission(store, QUIET_WINDOW_MS);
    const spoofed = await db.withTenant(practiceB, (sql) => {
      return sql`select pg_notify('bonfire_projection_change', ${VIEW})`;
    });
    if (!spoofed.ok) throw new Error(spoofed.error.code);
    expect(await emitted).toBe(false);
    expect(counter.queries).toBeGreaterThan(queriesBefore);
    await store.close();
  });

  test("rolled-back write emits nothing (NOTIFY is at-commit)", async () => {
    const store = await openStore(db);
    const emitted = nextEmission(store, QUIET_WINDOW_MS);
    const committed = await insertDemographic(practiceA, "GhostRow", true);
    expect(committed).toBe(false);
    expect(await emitted).toBe(false);
    await store.close();
  });

  test("non-whitelisted view: typed err, ZERO SQL, ZERO listens", async () => {
    const counter = { queries: 0 };
    const deadListener = {
      listen: (): Promise<never> => {
        throw new Error("listen must not be reached for a rejected view");
      }
    };
    const created = useClinicalQuery(sessionA, countingDb(db, counter), deadListener, {
      view: "fhir_resources"
    } as never);
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.error.code).toBe("INVALID_QUERY_OPTIONS");
    expect(counter.queries).toBe(0);
  });
});
