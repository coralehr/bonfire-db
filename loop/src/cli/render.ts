/**
 * Render a GateReport for humans (stderr) or machines (`--json`, stdout).
 *
 * "Silent success, verbose failure": a pass is one summary line; a failure lists
 * each red gate with its detail. The JSON shape is a stable contract for CI and
 * agent consumers — additive changes only.
 */
import type { GateReport } from "../gates/index.js";

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

export function renderReportHuman(report: GateReport): string {
  const lines: string[] = [];
  for (const result of report.results) {
    if (result.status === "fail") {
      lines.push(`✗ ${result.name} [${result.tier}] — ${result.summary}`);
      if (result.detail) lines.push(indent(result.detail));
    } else if (result.status === "skip") {
      lines.push(`- ${result.name} — ${result.summary}`);
    }
  }
  if (report.skippedStages.length > 0) {
    lines.push(`stage(s) ${report.skippedStages.join(", ")} not run after a blocking failure`);
  }
  const passed = report.results.filter((r) => r.status === "pass").length;
  const failed = report.results.filter((r) => r.status === "fail").length;
  const skipped = report.skipped.length;
  const mark = report.ok ? "✓" : "✗";
  const verdict = report.ok ? "PASS" : "FAIL";
  const tally = `${String(passed)} passed, ${String(failed)} failed, ${String(skipped)} skipped`;
  lines.push(`${mark} gate ${verdict} — ${tally}`);
  return `${lines.join("\n")}\n`;
}

export interface GateReportJson {
  readonly command: "gate";
  readonly status: "pass" | "fail";
  readonly exitCode: 0 | 1;
  readonly gates: readonly {
    readonly name: string;
    readonly stage: number;
    readonly tier: string;
    readonly status: string;
    readonly summary: string;
  }[];
  readonly blockingFailures: readonly string[];
  readonly advisoryFailures: readonly string[];
  readonly skipped: readonly string[];
  readonly skippedStages: readonly number[];
}

export function reportToJson(report: GateReport): GateReportJson {
  return {
    command: "gate",
    status: report.ok ? "pass" : "fail",
    exitCode: report.ok ? 0 : 1,
    gates: report.results.map((r) => ({
      name: r.name,
      stage: r.stage,
      tier: r.tier,
      status: r.status,
      summary: r.summary
    })),
    blockingFailures: report.blockingFailures.map((r) => r.name),
    advisoryFailures: report.advisoryFailures.map((r) => r.name),
    skipped: report.skipped.map((r) => r.name),
    skippedStages: report.skippedStages
  };
}
