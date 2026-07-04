/**
 * One write path, no dual write: the projection upsert runs INSIDE the
 * canonical write transaction, so a forced failure rolls back canonical FHIR,
 * vd_* rows and spidx rows together (zero partial state); and the upsert path
 * lands byte-identically to a full offline rebuild (no drift between the two
 * writers).
 */
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { insertFhirResourceTx } from "../../packages/core/src/index.js";
import { rebuildProjections, upsertProjection } from "../../packages/sql-on-fhir/src/index.js";
import type { TestContext } from "./helpers.js";
import {
  allTableHashes,
  insertCorpus,
  insertEntryTx,
  rebuildAll,
  registerRebuiltContext,
  syntheticCorpus
} from "./helpers.js";

let ctx: TestContext;
registerRebuiltContext((c) => {
  ctx = c;
});

/** Outer withTenant ok + inner typed err with the given code (fail-closed). */
function expectTypedErr(
  result: { ok: boolean; data?: { ok: boolean; error?: { code?: string } } },
  code: string
): void {
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data?.ok).toBe(false);
  if (result.data !== undefined && !result.data.ok) {
    expect(result.data.error?.code).toBe(code);
  }
}

describe("rolled-back write leaves ZERO rows anywhere", () => {
  test("insert + upsert + forced throw rolls back canonical, vd_* and spidx together", async () => {
    const practice = randomUUID();
    const corpus = syntheticCorpus();
    const patient = corpus.entries[0];
    if (patient === undefined) throw new Error("corpus is empty");
    const result = await ctx.db.withTenant(practice, async (sql) => {
      await insertEntryTx(sql, patient, ctx.views);
      // Prove the projection rows exist inside the transaction...
      const inTx = await sql`select id from vd_patient_demographics where id = ${patient.id}`;
      expect(inTx.length).toBe(1);
      // ...then force the canonical write transaction to fail.
      throw new Error("forced mid-write failure");
    });
    expect(result.ok).toBe(false);
    const counts = await ctx.owner`
      select
        (select count(*) from fhir_resources where id = ${patient.id}) as canonical,
        (select count(*) from vd_patient_demographics where id = ${patient.id}) as vd,
        (select count(*) from spidx where resource_id = ${patient.id}) as spidx`;
    expect(counts[0]?.canonical).toBe("0");
    expect(counts[0]?.vd).toBe("0");
    expect(counts[0]?.spidx).toBe("0");
  });

  test("upsert for a missing resource is a typed error and writes nothing", async () => {
    const practice = randomUUID();
    const ghost = randomUUID();
    const result = await ctx.db.withTenant(practice, async (sql) => {
      return await upsertProjection(sql, ghost, ctx.views);
    });
    expectTypedErr(result, "PROJECTION_RESOURCE_NOT_FOUND");
  });

  test("the tenant write path refuses a divergent content.id at insert time (BP-028)", async () => {
    // Since the BF-04 close-out, core's insertFhirResourceTx fails closed on
    // content.id !== id — a poisoned row can no longer enter via the tenant
    // path at all (packages/core/src/db/fhir-write.test.ts pins the same
    // check on the update path).
    const practice = randomUUID();
    const rowId = randomUUID();
    const divergent = { resourceType: "Patient", id: randomUUID(), active: true };
    const result = await ctx.db.withTenant(practice, async (sql) => {
      return await insertFhirResourceTx(sql, {
        id: rowId,
        type: "Patient",
        content: divergent,
        rawPayload: JSON.stringify(divergent)
      });
    });
    expectTypedErr(result, "INVALID_FHIR_INPUT");
  });

  test("a canonical row whose content.id diverges from its row id is refused (key mismatch)", async () => {
    // vd rows are keyed by the projected getResourceKey() (= content.id) but
    // addressed by fhir_resources.id; divergence would strand stale rows
    // under the old key on every upsert (projection-key-divergence class).
    // Core now refuses divergence at write time, so plant the row as the
    // OWNER (below the core check) — the upsert guard must fail closed on
    // its own, defense-in-depth.
    const practice = randomUUID();
    const rowId = randomUUID();
    const divergentContentId = randomUUID();
    const divergent = { resourceType: "Patient", id: divergentContentId, active: true };
    await ctx.owner`
      insert into fhir_resources (id, type, practice_id, version_id, last_updated, content)
      values (${rowId}, 'Patient', ${practice}, 1, now(), ${ctx.owner.json(divergent)})`;
    try {
      const result = await ctx.db.withTenant(practice, async (sql) => {
        return await upsertProjection(sql, rowId, ctx.views);
      });
      expectTypedErr(result, "PROJECTION_KEY_MISMATCH");
      // Nothing was projected for either id.
      const counts = await ctx.owner`
        select
          (select count(*) from vd_patient_demographics where id in (${rowId}, ${divergentContentId})) as vd,
          (select count(*) from spidx where resource_id = ${rowId}) as spidx`;
      expect(counts[0]?.vd).toBe("0");
      expect(counts[0]?.spidx).toBe("0");
    } finally {
      await ctx.owner`delete from fhir_resources where id = ${rowId}`;
    }
  });
});

describe("rebuild refuses a divergent canonical row (key mismatch, owner side)", () => {
  test("a content.id that diverges from its row id fails the whole rebuild, zero writes", async () => {
    // The tenant write path can no longer create such a row (upsert refuses),
    // so plant it as the owner — the rebuild guard must fail closed on its
    // own, not rely on the upsert-side guard having run.
    const rowId = randomUUID();
    const practice = randomUUID();
    const divergent = { resourceType: "Patient", id: randomUUID(), active: true };
    await ctx.owner`
      insert into fhir_resources (id, type, practice_id, version_id, last_updated, content)
      values (${rowId}, 'Patient', ${practice}, 1, now(), ${ctx.owner.json(divergent)})`;
    try {
      const result = await rebuildProjections(ctx.owner, ctx.views);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("PROJECTION_KEY_MISMATCH");
      // The failed rebuild rolled back: existing vd rows are still intact.
      const vd = await ctx.owner`select count(*)::int as n from vd_patient_demographics`;
      expect(Number(vd[0]?.n)).toBeGreaterThan(0);
    } finally {
      await ctx.owner`delete from fhir_resources where id = ${rowId}`;
    }
  });
});

describe("upsert-vs-rebuild parity", () => {
  test("in-transaction upserts land byte-identically to a full offline rebuild", async () => {
    const practice = randomUUID();
    await insertCorpus(ctx.db, practice, syntheticCorpus().entries, ctx.views);
    const afterUpserts = await allTableHashes(ctx.owner, ctx.plans);
    await rebuildAll(ctx.owner, ctx.views);
    const afterRebuild = await allTableHashes(ctx.owner, ctx.plans);
    expect(afterRebuild).toEqual(afterUpserts);
  });
});
