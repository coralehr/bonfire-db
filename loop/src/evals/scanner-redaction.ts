/**
 * Execution eval bf02-scanner-error-redacts-content (guards ratchet BP-017).
 *
 * Runs the BUILT scanner CLI on a committed malformed input and asserts its
 * operational-error path redacts: the output carries the location-only sentinel
 * and never the source content, and the run exits on the operational-error code
 * (2), not a false clean. This is Stage-2 coverage no unit test provides —
 * nothing else spawns the scanner on a malformed file and inspects its stderr.
 *
 * Inversion (why it is not a relabel): reverting the BP-017 redaction (letting
 * the raw JSON.parse error propagate) drops the sentinel from the output, so
 * this eval goes red. Note: on Bun/JSC the raw parser message is content-free
 * ("JSON Parse error: Expected '}'"), so the marker-absence check is
 * cross-runtime defense-in-depth (it would catch a V8/Node leak); the sentinel
 * check is what makes the inversion robust on the actual runtime.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const scanner = join(repoRoot, "scripts", "synthetic-scan", "index.ts");
const canary = join(repoRoot, "loop", "evals", "fixtures", "malformed.txt");

const CANARY_MARKER = "PHI-CANARY-Xq7-DO-NOT-ECHO";
const REDACTION_SENTINEL = "(content not shown)";
const OPERATIONAL_ERROR_EXIT = 2;

function fail(reason: string): never {
  process.stderr.write(`eval bf02-scanner-error-redacts-content FAILED: ${reason}\n`);
  process.exit(1);
}

const run = spawnSync("bun", [scanner, canary], { cwd: repoRoot, encoding: "utf8" });
if (run.error !== undefined) fail(`could not run the scanner: ${run.error.message}`);
const output = `${run.stdout}${run.stderr}`;

if (run.status !== OPERATIONAL_ERROR_EXIT) {
  fail(
    `scanner exited ${String(run.status)}, expected ${String(OPERATIONAL_ERROR_EXIT)} — the malformed input did not reach the operational-error path`
  );
}
if (!output.includes(REDACTION_SENTINEL)) {
  fail(
    `operational-error output lacks the "${REDACTION_SENTINEL}" sentinel — the parse-error redaction is gone`
  );
}
if (output.includes(CANARY_MARKER)) {
  fail(
    `operational-error output echoed the canary marker "${CANARY_MARKER}" — source content leaked`
  );
}

process.stdout.write(
  "eval bf02-scanner-error-redacts-content: redaction holds (sentinel present, no content echo)\n"
);
