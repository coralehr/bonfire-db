/**
 * `loop gate` — run the deterministic gate stack, fail-closed.
 *
 * Thin shell: parse flags, build the production context, hand the gate list to
 * the pure `runGates`, render, and map the report to an exit code. `--slice`
 * appends the allowed-paths check for that slice's diff vs `--base`; `--strict`
 * makes a skipped blocking gate a failure (CI/authoritative mode).
 */
import { parseArgs } from "node:util";
import {
  type Gate,
  makeAllowedPathsGate,
  makeGateContext,
  runGates,
  STANDARD_GATES
} from "../../gates/index.js";
import { ExitCode } from "../exit-codes.js";
import type { CliIO } from "../io.js";
import { renderReportHuman, reportToJson } from "../render.js";
import { resolveRepoRoot } from "../repo.js";

interface GateValues {
  readonly slice?: string;
  readonly base: string;
  readonly strict: boolean;
  readonly json: boolean;
}

export function runGateCommand(io: CliIO, args: readonly string[]): number {
  let values: GateValues;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        slice: { type: "string" },
        base: { type: "string", default: "main" },
        strict: { type: "boolean", default: false },
        json: { type: "boolean", default: false }
      },
      allowPositionals: false,
      strict: true
    }));
  } catch (error) {
    io.stderr(`loop gate: ${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.USAGE;
  }

  const repoRoot = resolveRepoRoot(io.cwd);
  if (repoRoot === null) {
    io.stderr("loop gate: not inside a git repository\n");
    return ExitCode.USAGE;
  }

  const ctx = makeGateContext(repoRoot);
  const gates: readonly Gate[] = values.slice
    ? [...STANDARD_GATES, makeAllowedPathsGate(values.slice, values.base)]
    : STANDARD_GATES;

  const report = runGates(gates, ctx, { strict: values.strict });

  if (values.json) {
    io.stdout(`${JSON.stringify(reportToJson(report))}\n`);
  } else {
    io.stderr(renderReportHuman(report));
  }

  return report.ok ? ExitCode.OK : ExitCode.FAILURE;
}
