/**
 * Conformance runner: executes EVERY vendored case through the same
 * `evaluateView` engine the materializer uses. Skip honesty is structural:
 * the only skip state is "declared unsupported in the pinned manifest AND
 * still failing" — an undeclared failure fails the run, and an allowlisted
 * case that starts passing fails the run too (stale allowlist).
 */
import type { JsonObject } from "@bonfire/core";
import { canonicalizeJson } from "@bonfire/core";
import { evaluateView, validateView } from "../engine/evaluate.js";
import type { Row } from "../engine/selection.js";
import { parseViewDefinition } from "../view-definition.js";
import type { LoadedSuite } from "./loader.js";
import type {
  CaseResult,
  ConformanceFailure,
  ConformanceReport,
  OfficialReport
} from "./report.js";
import type { SuiteCase } from "./suite-schema.js";

type CaseOutcome = { readonly passed: true } | { readonly passed: false; readonly error: string };

function fail(error: string): CaseOutcome {
  return { passed: false, error };
}

function multisetEqual(actual: readonly Row[], expected: readonly Row[]): boolean {
  if (actual.length !== expected.length) return false;
  const canon = (rows: readonly Row[]): string[] => rows.map((row) => canonicalizeJson(row)).sort();
  const left = canon(actual);
  const right = canon(expected);
  return left.every((value, index) => value === right[index]);
}

function checkExpectations(
  suiteCase: SuiteCase,
  columns: readonly string[],
  rows: readonly Row[]
): CaseOutcome {
  if (suiteCase.expectError === true) {
    return fail("expected an error but the view evaluated cleanly");
  }
  if (suiteCase.expectColumns !== undefined) {
    const matches =
      suiteCase.expectColumns.length === columns.length &&
      suiteCase.expectColumns.every((name, index) => name === columns[index]);
    if (!matches) {
      return fail(
        `expected columns [${suiteCase.expectColumns.join(", ")}], got [${columns.join(", ")}]`
      );
    }
  }
  if (suiteCase.expect !== undefined && !multisetEqual(rows, suiteCase.expect)) {
    return fail(
      `row mismatch: expected ${JSON.stringify(suiteCase.expect)}, got ${JSON.stringify(rows)}`
    );
  }
  return { passed: true };
}

function runCase(resources: readonly JsonObject[], suiteCase: SuiteCase): CaseOutcome {
  const expectsError = suiteCase.expectError === true;
  const parsed = parseViewDefinition(suiteCase.view);
  if (!parsed.ok) {
    return expectsError ? { passed: true } : fail(parsed.error.message);
  }
  const columns = validateView(parsed.data);
  if (!columns.ok) {
    return expectsError ? { passed: true } : fail(columns.error.message);
  }
  const rows: Row[] = [];
  for (const resource of resources) {
    const evaluated = evaluateView(parsed.data, resource);
    if (!evaluated.ok) {
      return expectsError ? { passed: true } : fail(evaluated.error.message);
    }
    rows.push(...evaluated.data);
  }
  return checkExpectations(suiteCase, columns.data, rows);
}

function allowlistKey(file: string, title: string): string {
  return `${file}\u0000${title}`;
}

interface Tally {
  passed: number;
  failed: number;
  skippedDeclared: number;
  total: number;
  readonly failures: ConformanceFailure[];
}

function classifyCase(
  tally: Tally,
  file: string,
  title: string,
  outcome: CaseOutcome,
  declaredReason: string | undefined
): CaseResult {
  if (outcome.passed && declaredReason !== undefined) {
    tally.failed += 1;
    const reason = "stale allowlist: declared-unsupported case now passes";
    tally.failures.push({ file, title, reason });
    return { name: title, result: { passed: false, error: reason } };
  }
  if (outcome.passed) {
    tally.passed += 1;
    return { name: title, result: { passed: true } };
  }
  if (declaredReason !== undefined) {
    tally.skippedDeclared += 1;
    return {
      name: title,
      result: { passed: false, error: `declared unsupported: ${declaredReason}` }
    };
  }
  tally.failed += 1;
  tally.failures.push({ file, title, reason: outcome.error });
  return { name: title, result: { passed: false, error: outcome.error } };
}

/** Execute the full loaded suite and build the report. */
export function runSuite(suite: LoadedSuite): ConformanceReport {
  const declared = new Map<string, { file: string; title: string; reason: string }>();
  for (const entry of suite.manifest.declaredUnsupported) {
    declared.set(allowlistKey(entry.file, entry.title), entry);
  }
  const matchedAllowlist = new Set<string>();
  const official: OfficialReport = {};
  const tally: Tally = { passed: 0, failed: 0, skippedDeclared: 0, total: 0, failures: [] };
  for (const { name, file } of suite.files) {
    const results: CaseResult[] = [];
    for (const suiteCase of file.tests) {
      tally.total += 1;
      const key = allowlistKey(name, suiteCase.title);
      const entry = declared.get(key);
      if (entry !== undefined) matchedAllowlist.add(key);
      const outcome = runCase(file.resources, suiteCase);
      results.push(classifyCase(tally, name, suiteCase.title, outcome, entry?.reason));
    }
    official[name] = { tests: results };
  }
  for (const [key, entry] of declared) {
    if (!matchedAllowlist.has(key)) {
      tally.failed += 1;
      tally.failures.push({
        file: entry.file,
        title: entry.title,
        reason: "stale allowlist: entry matches no vendored case"
      });
    }
  }
  return {
    total: tally.total,
    passed: tally.passed,
    failed: tally.failed,
    skippedDeclared: tally.skippedDeclared,
    failures: tally.failures,
    recountedCases: suite.recountedCases,
    manifestTotalCases: suite.manifest.totalCases,
    manifestShareableCases: suite.manifest.shareableCases,
    official
  };
}
