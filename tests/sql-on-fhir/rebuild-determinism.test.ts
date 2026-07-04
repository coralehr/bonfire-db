/**
 * BF-04-rebuild-determinism: the vd table + spidx read surface is a PURE FUNCTION
 * of canonical FHIR — dropping every projection table and rebuilding from
 * fhir_resources yields byte-identical ordered dumps; and the physical table
 * shape matches the ViewDefinition's declared columns and types.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { TestContext } from "./helpers.js";
import {
  allTableHashes,
  closeContext,
  initContext,
  insertCorpus,
  rebuildAll,
  syntheticCorpus
} from "./helpers.js";

let ctx: TestContext;

beforeAll(async () => {
  ctx = initContext();
  await insertCorpus(ctx.db, randomUUID(), syntheticCorpus().entries);
});

afterAll(async () => {
  await closeContext(ctx);
});

describe("drop + rebuild byte identity", () => {
  test("hashes are identical after DROP TABLE + full rebuild from canonical FHIR", async () => {
    const first = await rebuildAll(ctx.owner, ctx.views);
    expect(first.resources).toBeGreaterThan(0);
    const before = await allTableHashes(ctx.owner, ctx.plans);
    // Hard drop: prove the rebuild recreates everything from nothing.
    for (const plan of ctx.plans) {
      await ctx.owner`drop table ${ctx.owner(plan.table)}`;
    }
    await ctx.owner`truncate spidx restart identity`;
    const second = await rebuildAll(ctx.owner, ctx.views);
    const after = await allTableHashes(ctx.owner, ctx.plans);
    expect(second.resources).toBe(first.resources);
    expect(after).toEqual(before);
    // The hashes cover real rows, not empty tables.
    expect(Object.values(second.tableRows).some((count) => count > 0)).toBe(true);
    expect(second.spidxRows).toBeGreaterThan(0);
  });
});

describe("physical table shape matches the ViewDefinition", () => {
  const SYSTEM_COLUMNS: Record<string, string> = {
    practice_id: "uuid",
    row_index: "bigint",
    version_id: "bigint",
    last_updated: "timestamp with time zone"
  };

  test("every vd_* table exposes exactly the declared columns with mapped types", async () => {
    for (const plan of ctx.plans) {
      const rows = await ctx.owner`
        select column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = ${plan.table}
        order by ordinal_position`;
      const actual = Object.fromEntries(
        rows.map((row) => [String(row.column_name), String(row.data_type)])
      );
      const expected: Record<string, string> = { ...SYSTEM_COLUMNS };
      for (const column of plan.columns) expected[column.name] = column.pgType;
      expect(actual).toEqual(expected);
    }
  });

  test("the tenant-scoped primary key rides (practice_id, key, row_index)", async () => {
    for (const plan of ctx.plans) {
      const rows = await ctx.owner`
        select a.attname
        from pg_index i
        join pg_class c on c.oid = i.indrelid
        join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
        where c.relname = ${plan.table} and i.indisprimary
        order by array_position(i.indkey, a.attnum)`;
      expect(rows.map((row) => String(row.attname))).toEqual([
        "practice_id",
        plan.keyColumn,
        "row_index"
      ]);
    }
  });
});
