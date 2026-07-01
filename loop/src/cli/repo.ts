/**
 * Resolve the repo root via git plumbing, not a filesystem guess.
 *
 * Inside a linked worktree the top-level `.git` is a FILE, so naive
 * "is there a .git directory?" checks misfire (research worktree pitfall §2.4).
 * `git rev-parse --show-toplevel` is correct in the main checkout AND in any
 * worktree, so the CLI uses it to anchor gate and worktree operations.
 */
import { runCommand } from "../gates/exec.js";

export function resolveRepoRoot(cwd: string): string | null {
  const result = runCommand(["git", "rev-parse", "--show-toplevel"], { cwd });
  return result.ok ? result.output.trim() : null;
}
