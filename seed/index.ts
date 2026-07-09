/**
 * Idempotent synthetic-only seed CLI: verifies manifest hashes, then seeds
 * both fixed practices through the production write path (withTenant + RLS),
 * writing the completion marker LAST in the same transaction. A marker for
 * this manifest hash makes the run a no-op; a marker for a DIFFERENT hash is
 * a hard drift error, never a silent reseed. The --print-hashes flag prints
 * the paste-ready manifest "files" block and writes nothing to the database.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TenantDb } from "@bonfire/core";
import { connectTenantDb } from "@bonfire/core";
import { z } from "zod";
import type { ReIdedResource } from "./corpus.js";
import { insertCorpusResources, loadCorpus, reIdForPractice } from "./corpus.js";
import type { CorpusManifest, FileHashReport } from "./manifest.js";
import { loadManifest, manifestHash, reportFileHashes } from "./manifest.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = join(REPO_ROOT, "fixtures", "synthetic");
const MANIFEST_PATH = join(FIXTURES_DIR, "corpus.manifest.json");
const JSON_INDENT = 2;

const markerRowsSchema = z.array(z.object({ manifest_hash: z.string() }));
const countsRowSchema = z.object({
  fhir_resources: z.number(),
  history: z.number(),
  write_inputs: z.number(),
  seed_completions: z.number()
});

type SeedOutcome =
  | { readonly status: "noop" }
  | { readonly status: "drift"; readonly found: readonly string[] }
  | { readonly status: "seeded"; readonly inserted: number; readonly skipped: number }
  | { readonly status: "failed"; readonly code: string };

async function seedPractice(
  db: TenantDb,
  practiceId: string,
  resources: readonly ReIdedResource[],
  hash: string
): Promise<SeedOutcome> {
  const result = await db.withTenant(practiceId, async (sql): Promise<SeedOutcome> => {
    // BP-024: serialize concurrent seeders (parallel test suites self-seeding on
    // one DB) so both don't pass the marker-empty check and race the marker's
    // UNIQUE(practice_id, manifest_hash) into a spurious rollback. Transaction-
    // scoped, auto-released at commit; the loser then sees the marker and no-ops.
    await sql`select pg_advisory_xact_lock(hashtext('bonfire.seed'), hashtext(${practiceId}))`;
    const markerRows = await sql`select manifest_hash from seed_completions`;
    const markers = markerRowsSchema.parse([...markerRows]);
    if (markers.some((marker) => marker.manifest_hash === hash)) return { status: "noop" };
    if (markers.length > 0) {
      return { status: "drift", found: markers.map((marker) => marker.manifest_hash) };
    }
    const counts = await insertCorpusResources(sql, practiceId, resources);
    // Marker LAST, same transaction: a crash rolls back data AND marker.
    await sql`insert into seed_completions (practice_id, manifest_hash)
      values (${practiceId}, ${hash})`;
    return { status: "seeded", inserted: counts.inserted, skipped: counts.skipped };
  });
  if (!result.ok) return { status: "failed", code: result.error.code };
  return result.data;
}

async function tableCounts(db: TenantDb, practiceId: string): Promise<string> {
  const result = await db.withTenant(practiceId, async (sql) => {
    const rows = await sql`
      select (select count(*)::int from fhir_resources) as fhir_resources,
             (select count(*)::int from history) as history,
             (select count(*)::int from write_inputs) as write_inputs,
             (select count(*)::int from seed_completions) as seed_completions`;
    return countsRowSchema.parse(rows[0]);
  });
  if (!result.ok) return `counts unavailable [${result.error.code}]`;
  const counts = result.data;
  return [
    `fhir_resources=${String(counts.fhir_resources)}`,
    `history=${String(counts.history)}`,
    `write_inputs=${String(counts.write_inputs)}`,
    `seed_completions=${String(counts.seed_completions)}`
  ].join(" ");
}

/** Report one practice outcome; returns true when the run must fail. */
function reportOutcome(practiceId: string, outcome: SeedOutcome): boolean {
  switch (outcome.status) {
    case "noop":
      console.log(`practice ${practiceId}: already seeded for this manifest hash (no-op)`);
      return false;
    case "drift": {
      const found = outcome.found.join(", ");
      console.error(`practice ${practiceId}: seed DRIFT — marker exists for hash(es) ${found}`);
      console.error("refusing to reseed silently; align the manifest or reset the database");
      return true;
    }
    case "seeded": {
      const summary = `${String(outcome.inserted)} inserted, ${String(outcome.skipped)} skipped`;
      console.log(`practice ${practiceId}: seeded (${summary})`);
      return false;
    }
    case "failed":
      console.error(`practice ${practiceId}: seed transaction failed [${outcome.code}]`);
      return true;
  }
}

function printHashesBlock(reports: readonly FileHashReport[]): void {
  const files = reports.map((report) => ({
    path: report.path,
    resourceType: report.resourceType,
    count: report.actualCount,
    sha256: report.actualSha256
  }));
  console.log('Paste as the "files" value in fixtures/synthetic/corpus.manifest.json:');
  console.log(JSON.stringify(files, null, JSON_INDENT));
}

function verifyReports(reports: readonly FileHashReport[]): string[] {
  const problems: string[] = [];
  for (const report of reports) {
    if (report.actualSha256 !== report.expectedSha256) {
      problems.push(
        `${report.path}: sha256 expected ${report.expectedSha256} actual ${report.actualSha256}`
      );
    }
    if (report.actualCount !== report.expectedCount) {
      problems.push(
        `${report.path}: count expected ${String(report.expectedCount)} actual ${String(report.actualCount)}`
      );
    }
  }
  return problems;
}

async function seedAllPractices(manifest: CorpusManifest): Promise<number> {
  const problems = verifyReports(reportFileHashes(FIXTURES_DIR, manifest));
  if (problems.length > 0) {
    console.error("seed refused: fixture files do not match the manifest (expected vs actual):");
    for (const problem of problems) console.error(`  ${problem}`);
    console.error("run 'bun run seed --print-hashes' and paste the block into the manifest.");
    return 1;
  }
  const hash = manifestHash(manifest);
  const corpus = loadCorpus(FIXTURES_DIR, manifest);
  const db = connectTenantDb();
  try {
    for (const practiceId of manifest.practices) {
      const resources = reIdForPractice(practiceId, corpus);
      const outcome = await seedPractice(db, practiceId, resources, hash);
      if (reportOutcome(practiceId, outcome)) return 1;
      console.log(`practice ${practiceId}: ${await tableCounts(db, practiceId)}`);
    }
  } finally {
    await db.end();
  }
  return 0;
}

/**
 * BP-024 hermetic-test entrypoint: seed both fixed practices idempotently,
 * throwing on drift/failure. Safe to call from a DB test's beforeAll — the marker
 * check makes it a no-op once seeded and the advisory lock makes concurrent
 * callers safe, so a test never depends on `bun run seed` having run in boot.
 */
export async function seedIfNeeded(): Promise<void> {
  const manifestResult = loadManifest(MANIFEST_PATH);
  if (!manifestResult.ok) {
    throw new Error(
      `seedIfNeeded: manifest ${manifestResult.error.code} — ${manifestResult.error.message}`
    );
  }
  const exit = await seedAllPractices(manifestResult.data);
  if (exit !== 0) throw new Error("seedIfNeeded: seed did not complete cleanly (see logs above)");
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const manifestResult = loadManifest(MANIFEST_PATH);
    if (!manifestResult.ok) {
      const { code, message } = manifestResult.error;
      console.error(`seed failed [${code}]: ${message}`);
      return 1;
    }
    if (argv.includes("--print-hashes")) {
      printHashesBlock(reportFileHashes(FIXTURES_DIR, manifestResult.data));
      return 0;
    }
    return await seedAllPractices(manifestResult.data);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "unknown failure";
    console.error(`seed crashed: ${detail}`);
    return 1;
  }
}

// Only run the CLI when executed directly — importing seedIfNeeded (e.g. from a
// hermetic test's beforeAll) must not trigger a seed run as an import side effect.
if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
