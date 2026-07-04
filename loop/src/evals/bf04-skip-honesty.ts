/**
 * Execution eval bf04-skip-honesty (BF-04 danger check: fake-conformance).
 *
 * Runs the BUILT conformance CLI and inspects the WRITTEN artifact
 * (packages/sql-on-fhir/test_report.json): the set of non-passing cases in
 * the report must equal EXACTLY the MANIFEST's declaredUnsupported set — in
 * both directions — and every one must carry the "declared unsupported"
 * marker. Stage-2 coverage no unit test provides: units assert the in-memory
 * tally; nothing else pins the persisted per-case artifact (the thing a
 * human or downstream harness would cite) against the manifest allowlist.
 *
 * Inversion: an undeclared skip, a case silently downgraded in the artifact,
 * or an allowlist entry with no matching artifact case fails this eval.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fail, pass, repoRoot, runArtifact } from "./eval-util.js";

const EVAL_ID = "bf04-skip-honesty";
const DECLARED_MARKER = "declared unsupported:";

type OfficialReport = Record<
  string,
  { readonly tests: readonly { name: string; result: { passed: boolean; error?: string } }[] }
>;

interface Manifest {
  readonly declaredUnsupported: readonly { file: string; title: string; reason: string }[];
}

function key(file: string, title: string): string {
  return `${file}::${title}`;
}

const run = runArtifact(EVAL_ID, ["bun", "run", "conformance"]);
if (run.status !== 0) fail(EVAL_ID, `conformance CLI exited ${String(run.status)}:\n${run.output}`);

const report = JSON.parse(
  readFileSync(join(repoRoot, "packages", "sql-on-fhir", "test_report.json"), "utf8")
) as OfficialReport;
const manifest = JSON.parse(
  readFileSync(join(repoRoot, "fixtures", "sql-on-fhir", "MANIFEST.json"), "utf8")
) as Manifest;

const declared = new Set(manifest.declaredUnsupported.map((entry) => key(entry.file, entry.title)));
const nonPassing = new Map<string, string>();
for (const [file, entry] of Object.entries(report)) {
  for (const testCase of entry.tests) {
    if (!testCase.result.passed) {
      nonPassing.set(key(file, testCase.name), testCase.result.error ?? "");
    }
  }
}

for (const [caseKey, error] of nonPassing) {
  if (!declared.has(caseKey)) {
    fail(EVAL_ID, `artifact carries an UNDECLARED non-passing case: ${caseKey} (${error})`);
  }
  if (!error.startsWith(DECLARED_MARKER)) {
    fail(EVAL_ID, `${caseKey} is declared but its artifact error lacks the marker: ${error}`);
  }
}
for (const declaredKey of declared) {
  if (!nonPassing.has(declaredKey)) {
    fail(EVAL_ID, `allowlist entry has no non-passing artifact case (stale?): ${declaredKey}`);
  }
}
pass(
  EVAL_ID,
  `artifact skips == declared allowlist (${String(declared.size)} cases, both directions)`
);
