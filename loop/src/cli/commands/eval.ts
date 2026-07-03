/**
 * `loop eval` — run the Stage-2 execution-watching eval corpus, fail-closed.
 *
 * Thin shell, mirroring `loop gate`: parse flags, load the corpus (a malformed
 * or missing corpus is a LOUD failure, never a vacuous zero-eval pass), filter
 * by `--slice`, build Stage-2 gates, and hand them to the same pure `runGates`.
 * The slice `verify[]` chains call `loop eval --slice BF-NN`, so the command is
 * first-class (not a `loop gate` flag).
 */
import { parseArgs } from "node:util";
import { readEvalCorpus } from "../../evals/corpus.js";
import { makeEvalGates } from "../../gates/evals.js";
import { makeGateContext, runGates } from "../../gates/index.js";
import { ExitCode } from "../exit-codes.js";
import type { CliIO } from "../io.js";
import { renderReportHuman, reportToJson } from "../render.js";
import { resolveRepoRoot } from "../repo.js";

interface EvalValues {
  readonly slice?: string;
  readonly strict: boolean;
  readonly json: boolean;
}

export function runEvalCommand(io: CliIO, args: readonly string[]): number {
  let values: EvalValues;
  try {
    ({ values } = parseArgs({
      args: [...args],
      options: {
        slice: { type: "string" },
        strict: { type: "boolean", default: false },
        json: { type: "boolean", default: false }
      },
      allowPositionals: false,
      strict: true
    }));
  } catch (error) {
    io.stderr(`loop eval: ${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.USAGE;
  }

  const repoRoot = resolveRepoRoot(io.cwd);
  if (repoRoot === null) {
    io.stderr("loop eval: not inside a git repository\n");
    return ExitCode.USAGE;
  }

  const corpus = readEvalCorpus(repoRoot);
  if (!corpus.ok) {
    io.stderr(`loop eval: eval corpus invalid —\n  ${corpus.error.issues.join("\n  ")}\n`);
    return ExitCode.FAILURE;
  }

  const cases = values.slice ? corpus.value.filter((c) => c.slice === values.slice) : corpus.value;
  const report = runGates(makeEvalGates(cases), makeGateContext(repoRoot), {
    strict: values.strict
  });

  if (values.json) {
    io.stdout(`${JSON.stringify(reportToJson(report, "eval"))}\n`);
  } else {
    io.stderr(renderReportHuman(report, "eval"));
  }

  return report.ok ? ExitCode.OK : ExitCode.FAILURE;
}
