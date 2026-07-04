/**
 * One write path, no dual write: the projection upsert runs INSIDE the
 * canonical write transaction, so a forced failure rolls back canonical FHIR,
 * vd_* rows and spidx rows together (zero partial state); and the upsert path
 * lands byte-identically to a full offline rebuild (no drift between the two
 * writers).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { insertFhirResourceTx } from "../../packages/core/src/index.js";
import { rebuildProjections, upsertProjection } from "../../packages/sql-on-fhir/src/index.js";
import type { TestContext } from "./helpers.js";
import {
  allTableHashes,
  closeContext,
  initContext,
  insertCorpus,
  insertEntryTx,
  rebuildAll,
  syntheticCorpus
} from "./helpers.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = initContext();
  await rebuildAll(ctx.owner, ctx.views);
});

afterAll(async () => {
  await closeContext(ctx);
});

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
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ok).toBe(false);
    if (!result.data.ok) {
      expect(result.data.error.code).toBe("PROJECTION_RESOURCE_NOT_FOUND");
    }
  });

  test("a canonical row whose content.id diverges from its row id is refused (key mismatch)", async () => {
    // vd rows are keyed by the projected getResourceKey() (= content.id) but
    // addressed by fhir_resources.id; divergence would strand stale rows
    // under the old key on every upsert (projection-key-divergence class).
    // The whole tx is rolled back at the end so the poisoned canonical row
    // never survives into later rebuilds (which refuse it with the same code).
    const practice = randomUUID();
    const rowId = randomUUID();
    const divergentContentId = randomUUID();
    let upsertCode: string | undefined;
    const result = await ctx.db.withTenant(practice, async (sql) => {
      const inserted = await insertFhirResourceTx(sql, {
        id: rowId,
        type: "Patient",
        content: { resourceType: "Patient", id: divergentContentId, active: true },
        rawPayload: JSON.stringify({ resourceType: "Patient", id: divergentContentId })
      });
      if (!inserted.ok) throw new Error(inserted.error.message);
      const upserted = await upsertProjection(sql, rowId, ctx.views);
      upsertCode = upserted.ok ? "unexpected-ok" : upserted.error.code;
      throw new Error("roll back the poisoned canonical row");
    });
    expect(result.ok).toBe(false);
    expect(upsertCode).toBe("PROJECTION_KEY_MISMATCH");
    // Nothing survived anywhere — canonical, vd, or spidx.
    const counts = await ctx.owner`
      select
        (select count(*) from fhir_resources where id = ${rowId}) as canonical,
        (select count(*) from vd_patient_demographics where id in (${rowId}, ${divergentContentId})) as vd,
        (select count(*) from spidx where resource_id = ${rowId}) as spidx`;
    expect(counts[0]?.canonical).toBe("0");
    expect(counts[0]?.vd).toBe("0");
    expect(counts[0]?.spidx).toBe("0");
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
