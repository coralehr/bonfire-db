/**
 * Typed single-resource reads off a vd_* projection use an INDEX under RLS —
 * EXPLAIN must show an Index Scan (never a Seq Scan) for the point lookup —
 * and the measured median latency over N reads is printed (target <5ms,
 * reported not asserted; CI hardware varies).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import type { TenantDb } from "../../packages/core/src/index.js";
import { ownerSql, tenantDb } from "./helpers.js";

const TABLE = "vd_patient_demographics";
const BULK_ROWS = 1000;
const TIMED_READS = 50;
const practice = randomUUID();
const probeId = randomUUID();

let owner: Sql;
let db: TenantDb;

interface PlanNode {
  readonly nodeType: string;
  readonly relation: string | undefined;
}

function flattenPlan(node: unknown, out: PlanNode[]): PlanNode[] {
  if (typeof node !== "object" || node === null) return out;
  const record = node as Record<string, unknown>;
  if (typeof record["Node Type"] === "string") {
    out.push({
      nodeType: record["Node Type"],
      relation: typeof record["Relation Name"] === "string" ? record["Relation Name"] : undefined
    });
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) for (const child of value) flattenPlan(child, out);
    else flattenPlan(value, out);
  }
  return out;
}

beforeAll(async () => {
  owner = ownerSql();
  db = tenantDb();
  const now = new Date().toISOString();
  const rows = Array.from({ length: BULK_ROWS }, (_, index) => ({
    practice_id: practice,
    row_index: 0,
    version_id: "1",
    last_updated: now,
    id: index === 0 ? probeId : randomUUID(),
    gender: index % 2 === 0 ? "female" : "male",
    birth_date: "1975-06-01",
    family_name: `Zz-Synthetic-${index}`,
    given_name: "Loadrow",
    identifier_system: "https://example.org/synthetic-mrn",
    identifier_value: `MRN-PERF-${index}`
  }));
  await owner`insert into ${owner(TABLE)} ${owner(rows)}`;
  await owner`analyze ${owner(TABLE)}`;
});

afterAll(async () => {
  await owner`delete from ${owner(TABLE)} where practice_id = ${practice}`;
  await owner.end({ timeout: 5 });
  await db.end();
});

describe("indexed point lookup under RLS", () => {
  test("EXPLAIN shows an Index Scan on the primary key, never a Seq Scan", async () => {
    const explained = await db.withTenant(practice, async (sql) => {
      return await sql`explain (format json) select * from ${sql(TABLE)} where id = ${probeId}`;
    });
    expect(explained.ok).toBe(true);
    if (!explained.ok) return;
    const planJson: unknown = explained.data[0]?.["QUERY PLAN"];
    const nodes = flattenPlan(planJson, []);
    const tableNodes = nodes.filter((node) => node.relation === TABLE);
    expect(tableNodes.length).toBeGreaterThan(0);
    expect(tableNodes.every((node) => node.nodeType.includes("Index Scan"))).toBe(true);
    expect(nodes.some((node) => node.nodeType === "Seq Scan")).toBe(false);
  });

  test(`median latency over ${TIMED_READS} point reads is measured and printed`, async () => {
    const timings = await db.withTenant(practice, async (sql) => {
      // Warm-up: plan cache + buffer cache.
      await sql`select * from ${sql(TABLE)} where id = ${probeId}`;
      const samples: number[] = [];
      for (let i = 0; i < TIMED_READS; i += 1) {
        const start = performance.now();
        const rows = await sql`select * from ${sql(TABLE)} where id = ${probeId}`;
        samples.push(performance.now() - start);
        expect(rows.length).toBe(1);
        expect(rows[0]?.identifier_value).toBe("MRN-PERF-0");
      }
      return samples;
    });
    expect(timings.ok).toBe(true);
    if (!timings.ok) return;
    const sorted = [...timings.data].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    expect(median).toBeGreaterThan(0);
    process.stdout.write(
      `vd point-read median: ${median.toFixed(3)}ms over ${TIMED_READS} reads (target <5ms)\n`
    );
  });
});
