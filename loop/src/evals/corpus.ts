/**
 * The eval corpus loader — git-versioned JSONL under loop/evals/, read strictly
 * (fail-loud, ids unique) via the shared JSONL parser. A missing directory or a
 * malformed line is a LOUD failure, never a silent zero-case pass — the same
 * posture as the KB loader and the BP-021 "narrowed-to-nothing must not pass"
 * lesson.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalCase } from "../contracts/eval-case.js";
import { evalCaseSchema } from "../contracts/eval-case.js";
import type { JsonlFailure } from "../contracts/jsonl.js";
import { parseJsonlRecords } from "../contracts/jsonl.js";
import type { Result } from "../contracts/result.js";
import { err } from "../contracts/result.js";

const EVALS_DIR = "loop/evals";

/** Load every `*.jsonl` case under loop/evals/ as one deduplicated corpus. */
export function readEvalCorpus(repoRoot: string): Result<readonly EvalCase[], JsonlFailure> {
  const dir = join(repoRoot, EVALS_DIR);
  if (!existsSync(dir)) {
    return err({ issues: [`${EVALS_DIR} not found — the eval corpus is load-bearing`] });
  }
  const text = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
  const parsed = parseJsonlRecords(text, evalCaseSchema, (record) => record.id);
  // Anti-BP-021: a corpus narrowed to zero cases must be a LOUD failure, never
  // a vacuous zero-eval pass. The corpus only ever grows (seeded evals stay).
  if (parsed.ok && parsed.value.length === 0) {
    return err({ issues: [`${EVALS_DIR} has no eval cases — the corpus never shrinks to empty`] });
  }
  return parsed;
}
