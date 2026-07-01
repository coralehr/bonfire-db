/**
 * Per-agent worktree isolation (loop-harness-plan.md primitive 2 / H3).
 *
 * Every writing agent gets its own throwaway worktree `bonfire-<slice>-<session>`
 * under a gitignored `.worktrees/` at the repo root — same volume as the repo (so
 * Bun's clonefile/hardlink install stays cheap; research §3.2, §5.2) and trivial
 * to sweep. One ephemeral branch per worktree. Git ops go through the injected
 * runner so they are testable; recoverable failures return a Result, not a throw.
 */
import { basename, dirname, join } from "node:path";
import { err, ok, type Result } from "../contracts/result.js";
import { type CommandRunner, commandDetail } from "../gates/exec.js";

export const WORKTREE_DIR = ".worktrees";
const AGENT_PREFIX = "bonfire-";

export interface WorktreeInfo {
  readonly path: string;
  /** null when the worktree is on a detached HEAD. */
  readonly branch: string | null;
  readonly head: string;
}

export function worktreeName(slice: string, session: string): string {
  return `${AGENT_PREFIX}${slice}-${session}`;
}

export function worktreePath(repoRoot: string, slice: string, session: string): string {
  return join(repoRoot, WORKTREE_DIR, worktreeName(slice, session));
}

/**
 * True for a worktree this harness created: a `bonfire-*` dir directly under
 * `.worktrees/`. The parent-dir check matters — the repo itself may be named
 * `bonfire-*` (e.g. `bonfire-db`) and must not be mistaken for an agent worktree.
 */
export function isAgentWorktree(path: string): boolean {
  return basename(dirname(path)) === WORKTREE_DIR && basename(path).startsWith(AGENT_PREFIX);
}

export interface CreatedWorktree {
  readonly path: string;
  readonly branch: string;
}

export function createWorktree(
  exec: CommandRunner,
  opts: { repoRoot: string; slice: string; session: string; base: string }
): Result<CreatedWorktree, string> {
  const path = worktreePath(opts.repoRoot, opts.slice, opts.session);
  const branch = worktreeName(opts.slice, opts.session);
  const result = exec(["git", "worktree", "add", "-b", branch, path, opts.base]);
  if (!result.ok) return err(commandDetail(result, "git worktree add failed"));
  return ok({ path, branch });
}

export function removeWorktree(
  exec: CommandRunner,
  path: string
): Result<{ readonly path: string }, string> {
  const result = exec(["git", "worktree", "remove", "--force", path]);
  if (!result.ok) return err(commandDetail(result, "git worktree remove failed"));
  return ok({ path });
}

export function listWorktrees(exec: CommandRunner): Result<readonly WorktreeInfo[], string> {
  const result = exec(["git", "worktree", "list", "--porcelain"]);
  if (!result.ok) return err(commandDetail(result, "git worktree list failed"));
  return ok(parseWorktreeList(result.output));
}

/** Parse `git worktree list --porcelain` into structured entries. */
export function parseWorktreeList(porcelain: string): readonly WorktreeInfo[] {
  const infos: WorktreeInfo[] = [];
  let path: string | null = null;
  let head = "";
  let branch: string | null = null;
  const flush = (): void => {
    if (path !== null) infos.push({ path, head, branch });
    path = null;
    head = "";
    branch = null;
  };
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "detached") {
      branch = null;
    } else if (line === "") {
      flush();
    }
  }
  flush();
  return infos;
}
