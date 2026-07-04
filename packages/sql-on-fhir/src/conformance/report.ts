/**
 * Conformance report shape (mirrors the upstream test-report.schema.json for
 * the JSON artifact) plus the pure exit-code rule: any unexpected failure —
 * including a count that disagrees with the independent recount — is non-zero.
 */
import { writeFileSync } from "node:fs";

export interface CaseResult {
  readonly name: string;
  readonly result: {
    readonly passed: boolean;
    readonly error?: string;
  };
}

/** The upstream-schema report artifact: file name -> executed cases. */
export type OfficialReport = Record<string, { readonly tests: readonly CaseResult[] }>;

export interface ConformanceFailure {
  readonly file: string;
  readonly title: string;
  readonly reason: string;
}

export interface ConformanceReport {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skippedDeclared: number;
  readonly failures: readonly ConformanceFailure[];
  /** Cases re-counted from the parsed suite files (independent of counters). */
  readonly recountedCases: number;
  readonly manifestTotalCases: number;
  readonly official: OfficialReport;
}

/** 0 only for a complete, honest run: no failures and consistent counts. */
export function exitCodeForReport(report: ConformanceReport): number {
  const executed = report.passed + report.failed + report.skippedDeclared;
  const consistent =
    report.total === executed &&
    report.total === report.recountedCases &&
    report.recountedCases === report.manifestTotalCases;
  return report.failed === 0 && consistent ? 0 : 1;
}

/** Persist the upstream-shaped JSON artifact (gitignored run output). */
export function writeReport(report: ConformanceReport, path: string): void {
  writeFileSync(path, `${JSON.stringify(report.official, null, 2)}\n`, "utf8");
}
