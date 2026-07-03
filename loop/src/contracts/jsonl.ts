/**
 * Strict JSONL record parsing — the shared, fail-loud load path for the repo's
 * human-curated ledgers (bug-patterns.jsonl, the eval corpus). One record per
 * line, each validated by a Zod schema, ids unique. A malformed line is a
 * programmer error the caller must fail LOUDLY on — never a skipped line and a
 * silently-forgotten record.
 *
 * Extracted so the KB loader and the eval-corpus loader share one
 * implementation instead of a copy (which jscpd, now blocking, would reject).
 */
import type { ZodType } from "zod";
import type { Result } from "./result.js";
import { err, ok } from "./result.js";

export interface JsonlFailure {
  readonly issues: readonly string[];
}

/**
 * Parse every non-blank line of `text` as a JSON record, validate it with
 * `schema`, and reject duplicate ids (via `idOf`). Returns all issues at once
 * so the curator fixes everything in one pass.
 */
export function parseJsonlRecords<T>(
  text: string,
  schema: ZodType<T>,
  idOf: (record: T) => string
): Result<readonly T[], JsonlFailure> {
  const issues: string[] = [];
  const records: T[] = [];
  const seen = new Set<string>();

  for (const [index, line] of text.split("\n").entries()) {
    const lineNo = String(index + 1);
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      issues.push(`line ${lineNo}: not valid JSON`);
      continue;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      issues.push(`line ${lineNo}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
      continue;
    }
    const id = idOf(parsed.data);
    if (seen.has(id)) {
      issues.push(`line ${lineNo}: duplicate id ${id}`);
      continue;
    }
    seen.add(id);
    records.push(parsed.data);
  }

  return issues.length > 0 ? err({ issues }) : ok(records);
}
