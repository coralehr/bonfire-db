/**
 * Allowed-paths drift check: the structural gate that keeps a maker inside its slice.
 *
 * DEFAULT-DENY (loop-harness-plan.md section 3.3): after normalization, a changed
 * file passes only if it matches >=1 of the slice's `allowedPaths` globs AND none
 * of the forbidden globs. Forbidden = a repo-wide floor (GLOBAL_FORBIDDEN_PATHS)
 * UNION the slice's own `forbiddenPaths`, so protection of secrets/real-data and of
 * the gates+harness+CI is a structural invariant of the checker — not per-slice
 * author discipline a drafter might forget. A file matching nothing, or one that
 * fails normalization (absolute path, `..` traversal, backslash separators), is a
 * violation. Recoverable + expected, so it is returned as a Result, never thrown.
 */
import picomatch from "picomatch";
import type { Result } from "./result.js";
import { err, ok } from "./result.js";
import type { SliceContract } from "./slice-contract.js";

/** A single out-of-scope file together with why it was rejected. */
export interface AllowedPathsViolation {
  readonly file: string;
  readonly reason: string;
}

/** The failure payload: every changed file that fell outside the slice's scope. */
export interface AllowedPathsFailure {
  readonly violations: readonly AllowedPathsViolation[];
}

/**
 * Repo-wide forbidden floor applied to EVERY slice on top of its own
 * `forbiddenPaths`: secrets, real/private data, and the gates+harness+CI a product
 * slice must never modify (a maker must not be able to weaken the gates that catch
 * it). `.env.example` is deliberately NOT matched — it is a committed template a
 * foundation slice is required to create. This floor is the security guarantee;
 * a slice's own `forbiddenPaths` only adds slice-specific extras on top.
 */
export const GLOBAL_FORBIDDEN_PATHS: readonly string[] = [
  ".env",
  ".env.!(example)",
  ".envrc",
  "fixtures/private/**",
  "seed/**/real*",
  "seed/**/real*/**",
  ".github/**",
  "loop/**",
  "eslint.config.*",
  "biome.json",
  ".dependency-cruiser.cjs",
  "knip.json",
  ".jscpd.json",
  "semgrep.yml",
  "sgconfig.yml",
  "sgrules/**",
  ".gitleaks.toml",
  "tsconfig.base.json",
  // The SQL-on-FHIR conformance TRUST ROOT (BP-030): the manifest pins the
  // vendored suite bytes, the case counts, and the shareable pass floor. A
  // maker who can edit it can downgrade regressed cases into the allowlist
  // and keep the run green; only operator prep (pre-base) may re-pin it.
  "fixtures/sql-on-fhir/MANIFEST.json"
];

// `dot: true` so globs catch dotfiles (e.g. `.env`) and `**` matches hidden
// segments — a security matcher must not silently skip hidden paths.
const MATCHER_OPTIONS: picomatch.PicomatchOptions = { dot: true };

/**
 * Normalize a changed-file path to a repo-relative POSIX path, or reject it.
 * Rejecting (rather than silently matching) closes bypasses where an absolute or
 * `..`-laden path would dodge the forbidden globs under a wide allow.
 */
function normalizeRepoPath(file: string): Result<string, string> {
  if (file.length === 0) {
    return err("empty path");
  }
  if (file.includes("\\")) {
    return err("backslash path separator (expected POSIX)");
  }
  if (file.startsWith("/")) {
    return err("absolute path (expected repo-relative)");
  }
  const stripped = file.startsWith("./") ? file.slice(2) : file;
  if (stripped.split("/").includes("..")) {
    return err("parent-directory traversal (..)");
  }
  return ok(stripped);
}

/**
 * Check a set of changed files against a slice's allowed globs and the union of the
 * global forbidden floor with the slice's own forbidden globs. Returns
 * `ok({ ok: true })` when every file is in scope, otherwise the full violation list.
 */
export function checkAllowedPaths(
  slice: SliceContract,
  changedFiles: readonly string[]
): Result<{ readonly ok: true }, AllowedPathsFailure> {
  const isAllowed = picomatch([...slice.allowedPaths], MATCHER_OPTIONS);
  const isForbidden = picomatch(
    [...GLOBAL_FORBIDDEN_PATHS, ...slice.forbiddenPaths],
    MATCHER_OPTIONS
  );

  const violations: AllowedPathsViolation[] = [];
  for (const raw of changedFiles) {
    const normalized = normalizeRepoPath(raw);
    if (!normalized.ok) {
      violations.push({ file: raw, reason: normalized.error });
      continue;
    }
    const file = normalized.value;
    if (isForbidden(file)) {
      violations.push({
        file,
        reason: `matches a forbidden path (global floor or slice ${slice.id})`
      });
    } else if (!isAllowed(file)) {
      violations.push({
        file,
        reason: `matches no allowed path in slice ${slice.id} (default-deny)`
      });
    }
  }

  return violations.length > 0 ? err({ violations }) : ok({ ok: true });
}
