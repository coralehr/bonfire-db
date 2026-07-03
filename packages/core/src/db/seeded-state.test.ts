/**
 * BF-02 seeded-state proofs — run AFTER `bun run seed` (the verify order).
 *
 * Asserts the manifest ⇄ database contract for BOTH fixed seed practices:
 * counts match the manifest exactly (idempotent — a second seed run must not
 * change them), write_inputs parity holds 1:1, and the completion marker
 * carries the manifest hash the seed honored.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalizeJson } from "./canonical-json.js";
import { createSqlClient } from "./client.js";
import { resolveDatabaseTarget } from "./env.js";
import { createTenantDb } from "./tenant.js";

const MANIFEST_URL = new URL(
  "../../../../fixtures/synthetic/corpus.manifest.json",
  import.meta.url
);
const manifest = JSON.parse(readFileSync(MANIFEST_URL, "utf8"));
const practices = manifest.practices;
const expectedTotal = manifest.files.reduce((sum, file) => sum + file.count, 0);
const expectedManifestHash = createHash("sha256")
  .update(canonicalizeJson(manifest), "utf8")
  .digest("hex");

const sql = createSqlClient(resolveDatabaseTarget(), { max: 1 });
const db = createTenantDb(sql);

async function seededState(practiceId: string) {
  const result = await db.withTenant(practiceId, async (sql) => {
    const totals = await sql<{ latest: number; history: number; inputs: number }[]>`
      select (select count(*)::int from fhir_resources) as latest,
             (select count(*)::int from history) as history,
             (select count(*)::int from write_inputs) as inputs`;
    const byType = await sql<{ type: string; n: number }[]>`
      select type, count(*)::int as n from fhir_resources group by type order by type`;
    const markers = await sql<{ manifest_hash: string }[]>`
      select manifest_hash from seed_completions`;
    const orphans = await sql<{ n: number }[]>`
      select count(*)::int as n from fhir_resources f
      left join write_inputs w on w.fhir_resource_id = f.id
      where w.id is null`;
    return {
      totals: totals[0],
      byType: [...byType],
      markers: [...markers],
      orphans: orphans[0]?.n
    };
  });
  if (!result.ok) throw new Error(`withTenant failed for seed practice ${practiceId}`);
  return result.data;
}

afterAll(async () => {
  await db.end();
});

describe("seed ⇄ manifest contract (both fixed practices)", () => {
  test("marker honored, counts match manifest", async () => {
    expect(practices.length).toBe(2);
    for (const practiceId of practices) {
      const state = await seededState(practiceId);
      expect(state.markers.length).toBe(1);
      expect(state.markers[0]?.manifest_hash).toBe(expectedManifestHash);
      expect(state.totals?.latest).toBe(expectedTotal);
      // Seed writes version 1 only: history must equal resources exactly.
      expect(state.totals?.history).toBe(expectedTotal);
      for (const file of manifest.files) {
        const row = state.byType.find((entry) => entry.type === file.resourceType);
        expect(row?.n).toBe(file.count);
      }
    }
  });

  test("write_inputs count equals fhir_resources count", async () => {
    for (const practiceId of practices) {
      const state = await seededState(practiceId);
      expect(state.totals?.inputs).toBe(state.totals?.latest);
      expect(state.totals?.inputs).toBe(expectedTotal);
      // FK + UNIQUE parity: no resource is missing its verbatim payload.
      expect(state.orphans).toBe(0);
    }
  });
});
