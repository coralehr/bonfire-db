/**
 * One write path, no dual write: the projection upsert runs INSIDE the
 * canonical write transaction, so a forced failure rolls back canonical FHIR,
 * vd_* rows and spidx rows together (zero partial state); and the upsert path
 * lands byte-identically to a full offline rebuild (no drift between the two
 * writers).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { upsertProjection } from "../../packages/sql-on-fhir/src/index.js";
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
