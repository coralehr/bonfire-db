/**
 * The bug-patterns KB: typed schema + STRICT loader (loop-harness-plan.md H4/A5).
 *
 * Every confirmed failure becomes one JSONL entry in `loop/memory/bug-patterns.jsonl`.
 * The invariant this encodes: a bug is CLOSED (`status: "guarded"`) only when a
 * permanent, machine-checkable guard exists — named by `guard.type` + `guard.ref`
 * — otherwise it stays `"open"` with a `plannedGuard` naming the debt. The
 * ratchet (./ratchet.ts) enforces that guarded refs really exist and match.
 *
 * The loader is deliberately strict, not tolerant: this file is human-curated,
 * so a malformed line is a programmer error the ratchet must fail LOUDLY on
 * (T4) — never skip a line and silently forget a bug.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Result } from "../contracts/result.js";
import { err, ok } from "../contracts/result.js";

export const BUG_PATTERNS_FILE = "loop/memory/bug-patterns.jsonl";

/** How a bug class is permanently guarded. Each type has a checkable ref grammar. */
export const guardTypeSchema = z.enum(["ast-grep", "semgrep", "test", "eval", "checklist"]);
export type GuardType = z.infer<typeof guardTypeSchema>;

const nonEmptyString = z.string().min(1);

/**
 * Ref grammar by type — kept machine-checkable so closure is provable:
 *   ast-grep  → rule file path (e.g. "sgrules/no-fail-open-auth.yml")
 *   semgrep   → rule id inside semgrep.yml (e.g. "bonfire-fail-open-authz")
 *   test      → "<file>::<test-name-substring>" the file must contain
 *   eval      → eval case file/id (arrives with the H5 eval harness)
 *   checklist → generated checklist file path
 */
export const guardSchema = z.strictObject({
  type: guardTypeSchema,
  ref: nonEmptyString
});
export type Guard = z.infer<typeof guardSchema>;

export const BUG_ID_PATTERN = /^BP-\d{3}$/;
const KEBAB_PATTERN = /^[a-z][a-z0-9-]*$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const bugPatternSchema = z
  .strictObject({
    id: z.string().regex(BUG_ID_PATTERN, "id must match /^BP-\\d{3}$/"),
    class: z.string().regex(KEBAB_PATTERN, "class must be kebab-case"),
    recorded: z.string().regex(ISO_DATE_PATTERN, "recorded must be YYYY-MM-DD"),
    symptom: nonEmptyString,
    rootCause: nonEmptyString,
    fix: nonEmptyString,
    // guarded = proven guard exists; open = debt, plannedGuard names it;
    // retired = class deliberately obsoleted in a reviewed diff (skipped by closure).
    status: z.enum(["open", "guarded", "retired"]),
    guard: guardSchema.optional(),
    plannedGuard: nonEmptyString.optional()
  })
  .refine((entry) => (entry.status === "guarded" ? entry.guard !== undefined : true), {
    message: "a guarded entry must name its guard"
  })
  .refine((entry) => (entry.status === "open" ? entry.plannedGuard !== undefined : true), {
    message: "an open entry must name its plannedGuard (the debt)"
  })
  .refine((entry) => (entry.status === "open" ? entry.guard === undefined : true), {
    message: "an open entry must not claim a guard (close it instead)"
  });
export type BugPattern = z.infer<typeof bugPatternSchema>;

export interface BugPatternsFailure {
  readonly issues: readonly string[];
}

/** Parse + validate KB text. Strict: every line must be a valid entry; ids unique. */
export function parseBugPatterns(text: string): Result<readonly BugPattern[], BugPatternsFailure> {
  const issues: string[] = [];
  const entries: BugPattern[] = [];
  const seen = new Set<string>();

  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    const lineNo = String(index + 1);
    if (line.trim().length === 0) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      issues.push(`line ${lineNo}: not valid JSON`);
      continue;
    }
    const parsed = bugPatternSchema.safeParse(raw);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => i.message).join("; ");
      issues.push(`line ${lineNo}: ${detail}`);
      continue;
    }
    if (seen.has(parsed.data.id)) {
      issues.push(`line ${lineNo}: duplicate id ${parsed.data.id}`);
      continue;
    }
    seen.add(parsed.data.id);
    entries.push(parsed.data);
  }

  return issues.length > 0 ? err({ issues }) : ok(entries);
}

/** Load the real KB from the repo. A missing file is a loud failure, not empty memory. */
export function readBugPatterns(
  repoRoot: string
): Result<readonly BugPattern[], BugPatternsFailure> {
  const path = join(repoRoot, BUG_PATTERNS_FILE);
  if (!existsSync(path)) {
    return err({ issues: [`${BUG_PATTERNS_FILE} not found — the KB is load-bearing memory`] });
  }
  return parseBugPatterns(readFileSync(path, "utf8"));
}
