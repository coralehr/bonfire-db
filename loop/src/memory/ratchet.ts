/**
 * The Ratchet: memory enforced by the toolchain, not recalled by an agent (T4).
 *
 * `checkRatchet` recomputes the closure invariant over the whole KB: an entry
 * may claim `status: "guarded"` ONLY if its named guard artifact exists and is
 * proven — status is earned, never declared. Per guard type:
 *   ast-grep → the rule file exists AND its paired behaviour test
 *              (sgrule-tests/<name>-test.yml) exists; `ast-grep test` in the
 *              structural gate then proves the rule fires on known-bad code.
 *   semgrep  → the rule id is present in semgrep.yml (validated by the CI scan).
 *   test     → "<file>::<name>" — the file exists and contains that test name,
 *              so deleting or renaming the regression test reopens the bug.
 *   eval / checklist → the referenced artifact file exists (layers arrive H5+).
 *
 * A malformed KB fails LOUDLY before any checking (strict loader), and
 * `renderRatchetDoc` regenerates docs/loop/RATCHET.md from the KB — the
 * generated doc is drift-checked like the H2 agent files.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { Result } from "../contracts/result.js";
import { err, ok } from "../contracts/result.js";
import type { BugPattern, BugPatternsFailure, Guard } from "./bug-pattern.js";
import { readBugPatterns } from "./bug-pattern.js";

export const RATCHET_DOC_FILE = "docs/loop/RATCHET.md";
const SEMGREP_RULES_FILE = "semgrep.yml";
const SGRULE_TESTS_DIR = "sgrule-tests";

export interface RatchetViolation {
  readonly id: string;
  readonly problem: string;
}

export interface RatchetReport {
  readonly ok: boolean;
  readonly entries: readonly BugPattern[];
  readonly guarded: number;
  readonly open: number;
  readonly retired: number;
  readonly violations: readonly RatchetViolation[];
}

function checkAstGrepGuard(repoRoot: string, ref: string): string | null {
  if (!existsSync(join(repoRoot, ref))) return `ast-grep rule file missing: ${ref}`;
  const testFile = join(SGRULE_TESTS_DIR, `${basename(ref, ".yml")}-test.yml`);
  if (!existsSync(join(repoRoot, testFile))) {
    return `unproven guard — no behaviour test at ${testFile}`;
  }
  return null;
}

function checkSemgrepGuard(repoRoot: string, ref: string): string | null {
  const rulesPath = join(repoRoot, SEMGREP_RULES_FILE);
  if (!existsSync(rulesPath)) return `${SEMGREP_RULES_FILE} missing`;
  if (!readFileSync(rulesPath, "utf8").includes(`id: ${ref}`)) {
    return `semgrep rule id not found in ${SEMGREP_RULES_FILE}: ${ref}`;
  }
  return null;
}

function checkTestGuard(repoRoot: string, ref: string): string | null {
  const [file, testName] = ref.split("::");
  if (file === undefined || testName === undefined || testName.length === 0) {
    return `test guard ref must be "<file>::<test-name>": ${ref}`;
  }
  const path = join(repoRoot, file);
  if (!existsSync(path)) return `test file missing: ${file}`;
  if (!readFileSync(path, "utf8").includes(testName)) {
    return `test "${testName}" not found in ${file} — the regression guard is gone`;
  }
  return null;
}

/** Null when the guard is present and proven; otherwise the problem. */
export function checkGuard(repoRoot: string, guard: Guard): string | null {
  switch (guard.type) {
    case "ast-grep":
      return checkAstGrepGuard(repoRoot, guard.ref);
    case "semgrep":
      return checkSemgrepGuard(repoRoot, guard.ref);
    case "test":
      return checkTestGuard(repoRoot, guard.ref);
    case "eval":
    case "checklist":
      return existsSync(join(repoRoot, guard.ref)) ? null : `guard artifact missing: ${guard.ref}`;
  }
}

/** Load the KB and recompute closure. err = malformed KB (T4: fail loudly). */
export function checkRatchet(repoRoot: string): Result<RatchetReport, BugPatternsFailure> {
  const loaded = readBugPatterns(repoRoot);
  if (!loaded.ok) return err(loaded.error);

  const violations: RatchetViolation[] = [];
  for (const entry of loaded.value) {
    if (entry.status !== "guarded" || entry.guard === undefined) continue;
    const problem = checkGuard(repoRoot, entry.guard);
    if (problem !== null) violations.push({ id: entry.id, problem });
  }

  const count = (status: BugPattern["status"]): number =>
    loaded.value.filter((e) => e.status === status).length;

  return ok({
    ok: violations.length === 0,
    entries: loaded.value,
    guarded: count("guarded"),
    open: count("open"),
    retired: count("retired"),
    violations
  });
}

function renderEntry(entry: BugPattern): string {
  const guardLine =
    entry.guard !== undefined
      ? `- Guard: \`${entry.guard.type}\` → \`${entry.guard.ref}\``
      : `- Planned guard: ${entry.plannedGuard ?? "(none)"}`;
  return [
    `## ${entry.id} — ${entry.class} — ${entry.status.toUpperCase()}`,
    ``,
    `- Symptom: ${entry.symptom}`,
    `- Root cause: ${entry.rootCause}`,
    `- Fix: ${entry.fix}`,
    guardLine,
    `- Recorded: ${entry.recorded}`
  ].join("\n");
}

/** Render the human-readable ledger of "bugs this repo can never repeat". */
export function renderRatchetDoc(entries: readonly BugPattern[]): string {
  const sorted = [...entries].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const guarded = sorted.filter((e) => e.status === "guarded").length;
  const open = sorted.filter((e) => e.status === "open").length;
  return [
    `# The Ratchet — bug classes this repo must never repeat`,
    ``,
    `> GENERATED from \`loop/memory/bug-patterns.jsonl\` by \`bun run loop ratchet --write\`.`,
    `> Do not edit by hand. A GUARDED entry's guard is machine-verified by`,
    `> \`loop ratchet\` (and the test suite): if the guard artifact disappears,`,
    `> the check fails and the bug is considered reopened.`,
    ``,
    `${String(guarded)} guarded · ${String(open)} open (debt owed a guard)`,
    ``,
    sorted.map(renderEntry).join("\n\n"),
    ``
  ].join("\n");
}

/** Drift check: the committed doc must equal what the KB renders to. */
export function checkRatchetDocDrift(repoRoot: string, entries: readonly BugPattern[]): boolean {
  const path = join(repoRoot, RATCHET_DOC_FILE);
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8") === renderRatchetDoc(entries);
}
