/**
 * `bun run conformance` — execute the vendored HL7 SQL-on-FHIR suite against
 * the projection engine, print total/passed/failed/skipped counts, write the
 * upstream-shaped test_report.json, and exit non-zero on any unexpected
 * failure (silent success, verbose failure).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSuite } from "../conformance/loader.js";
import { exitCodeForReport, writeReport } from "../conformance/report.js";
import { runSuite } from "../conformance/runner.js";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// SQL_ON_FHIR_SUITE_DIR override: the harness mutation-canary eval points the
// CLI at a deliberately tampered COPY of the suite and requires a red run — a
// runner that echoes the manifest instead of evaluating views cannot pass it.
const SUITE_DIR =
  process.env.SQL_ON_FHIR_SUITE_DIR ?? join(PACKAGE_DIR, "..", "..", "fixtures", "sql-on-fhir");
const REPORT_PATH = join(PACKAGE_DIR, "test_report.json");

function main(): number {
  const suite = loadSuite(SUITE_DIR);
  if (!suite.ok) {
    process.stderr.write(
      `conformance suite refused to load: [${suite.error.code}] ${suite.error.message}\n`
    );
    return 1;
  }
  const report = runSuite(suite.data);
  writeReport(report, REPORT_PATH);
  process.stdout.write(
    `sql-on-fhir conformance: total=${String(report.total)} passed=${String(report.passed)} ` +
      `failed=${String(report.failed)} skipped(declared-unsupported)=${String(report.skippedDeclared)}\n`
  );
  for (const failure of report.failures) {
    process.stderr.write(`FAIL ${failure.file} :: ${failure.title}\n  ${failure.reason}\n`);
  }
  return exitCodeForReport(report);
}

process.exitCode = main();
