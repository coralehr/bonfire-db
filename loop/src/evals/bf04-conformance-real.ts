/**
 * Execution eval bf04-conformance-real (BF-04 danger check: fake-conformance).
 *
 * Runs the BUILT conformance CLI (`bun run conformance`) and cross-checks its
 * PRINTED counts against a from-scratch recount of the vendored suite bytes
 * and the MANIFEST pins — using none of the product's loader/runner code. A
 * stubbed CLI, a tampered counts line, or a pass count drifting from the
 * manifest's shareable pin goes red here even if every unit test was edited
 * in the same commit. Stage-2 coverage no unit test provides: the units
 * assert the in-memory report object; nothing else re-derives the totals and
 * compares them to what the CLI actually PRINTS.
 *
 * Inversion: stubbing the CLI to print a green line without executing (or
 * regressing a shareable case and growing the allowlist) breaks the printed
 * counts against the independent recount, so this eval fails.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, pass, repoRoot, runArtifact } from "./eval-util.js";

const EVAL_ID = "bf04-conformance-real";
const SUITE_DIR = join(repoRoot, "fixtures", "sql-on-fhir");

interface Manifest {
  readonly totalCases: number;
  readonly shareableCases: number;
  readonly declaredUnsupported: readonly { file: string; title: string }[];
}

function recountFromRawJson(): number {
  const dir = join(SUITE_DIR, "tests");
  let total = 0;
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("tests" in parsed)) {
      fail(EVAL_ID, `${name} has no tests[] array`);
    }
    const tests = parsed.tests;
    if (!Array.isArray(tests)) fail(EVAL_ID, `${name} tests is not an array`);
    total += tests.length;
  }
  return total;
}

function printedCounts(output: string): {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
} {
  const match =
    /conformance: total=(\d+) passed=(\d+) failed=(\d+) skipped\(declared-unsupported\)=(\d+)/.exec(
      output
    );
  if (match === null) fail(EVAL_ID, `counts line not found in CLI output:\n${output}`);
  return {
    total: Number(match[1]),
    passed: Number(match[2]),
    failed: Number(match[3]),
    skipped: Number(match[4])
  };
}

const run = runArtifact(EVAL_ID, ["bun", "run", "conformance"]);
if (run.status !== 0) fail(EVAL_ID, `conformance CLI exited ${String(run.status)}:\n${run.output}`);

const manifest = JSON.parse(readFileSync(join(SUITE_DIR, "MANIFEST.json"), "utf8")) as Manifest;
const counts = printedCounts(run.output);
const recount = recountFromRawJson();
const declared = manifest.declaredUnsupported.length;

if (counts.total !== recount) {
  fail(EVAL_ID, `printed total=${String(counts.total)} but raw recount=${String(recount)}`);
}
if (counts.total !== manifest.totalCases) {
  fail(EVAL_ID, `printed total disagrees with MANIFEST totalCases=${String(manifest.totalCases)}`);
}
if (counts.passed !== manifest.shareableCases || counts.passed !== recount - declared) {
  fail(
    EVAL_ID,
    `printed passed=${String(counts.passed)} must equal shareableCases=${String(manifest.shareableCases)} and recount-declared=${String(recount - declared)}`
  );
}
if (counts.failed !== 0 || counts.skipped !== declared) {
  fail(
    EVAL_ID,
    `failed=${String(counts.failed)} skipped=${String(counts.skipped)} vs declared=${String(declared)}`
  );
}
pass(EVAL_ID, `printed counts verified against raw recount (${String(recount)} cases)`);
