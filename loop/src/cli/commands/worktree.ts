/**
 * `loop worktree <create|list|remove>` — per-agent worktree isolation.
 *
 * Thin shell over the worktree library: `create` mints a unique
 * `bonfire-<slice>-<session>` worktree+branch, `list` shows only harness-created
 * worktrees, `remove` force-removes one. Each action is its own small handler.
 */
import { parseArgs } from "node:util";
import { type CommandRunner, makeRunner } from "../../gates/index.js";
import {
  createWorktree,
  isAgentWorktree,
  listWorktrees,
  removeWorktree
} from "../../worktree/index.js";
import { ExitCode } from "../exit-codes.js";
import type { CliIO } from "../io.js";
import { resolveRepoRoot } from "../repo.js";

const SESSION_RADIX = 36;
const SESSION_SUFFIX_END = 6;
const HEAD_ABBREV_LEN = 12;

function makeSession(): string {
  const stamp = Date.now().toString(SESSION_RADIX);
  const suffix = Math.random().toString(SESSION_RADIX).slice(2, SESSION_SUFFIX_END);
  return `${stamp}-${suffix}`;
}

function handleCreate(
  io: CliIO,
  exec: CommandRunner,
  args: { repoRoot: string; slice: string; base: string; json: boolean }
): number {
  const created = createWorktree(exec, {
    repoRoot: args.repoRoot,
    slice: args.slice,
    session: makeSession(),
    base: args.base
  });
  if (!created.ok) {
    io.stderr(`loop worktree: ${created.error}\n`);
    return ExitCode.FAILURE;
  }
  if (args.json) {
    io.stdout(`${JSON.stringify(created.value)}\n`);
  } else {
    io.stderr(`created ${created.value.path} on branch ${created.value.branch}\n`);
  }
  return ExitCode.OK;
}

function handleList(io: CliIO, exec: CommandRunner, json: boolean): number {
  const listed = listWorktrees(exec);
  if (!listed.ok) {
    io.stderr(`loop worktree: ${listed.error}\n`);
    return ExitCode.FAILURE;
  }
  const agents = listed.value.filter((worktree) => isAgentWorktree(worktree.path));
  if (json) {
    io.stdout(`${JSON.stringify(agents)}\n`);
  } else if (agents.length === 0) {
    io.stderr("no agent worktrees\n");
  } else {
    for (const worktree of agents) {
      const head = worktree.head.slice(0, HEAD_ABBREV_LEN);
      io.stderr(`${worktree.path}  ${worktree.branch ?? "(detached)"}  ${head}\n`);
    }
  }
  return ExitCode.OK;
}

function handleRemove(io: CliIO, exec: CommandRunner, path: string, json: boolean): number {
  const removed = removeWorktree(exec, path);
  if (!removed.ok) {
    io.stderr(`loop worktree: ${removed.error}\n`);
    return ExitCode.FAILURE;
  }
  if (json) {
    io.stdout(`${JSON.stringify(removed.value)}\n`);
  } else {
    io.stderr(`removed ${path}\n`);
  }
  return ExitCode.OK;
}

interface WorktreeValues {
  readonly base: string;
  readonly json: boolean;
}

export function runWorktreeCommand(io: CliIO, args: readonly string[]): number {
  let values: WorktreeValues;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...args],
      options: {
        base: { type: "string", default: "main" },
        json: { type: "boolean", default: false }
      },
      allowPositionals: true,
      strict: true
    }));
  } catch (error) {
    io.stderr(`loop worktree: ${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.USAGE;
  }

  const repoRoot = resolveRepoRoot(io.cwd);
  if (repoRoot === null) {
    io.stderr("loop worktree: not inside a git repository\n");
    return ExitCode.USAGE;
  }

  const exec = makeRunner(repoRoot, io.env);
  const [action, arg] = positionals;

  switch (action) {
    case "create":
      if (arg === undefined) {
        io.stderr("usage: loop worktree create <slice> [--base <ref>]\n");
        return ExitCode.USAGE;
      }
      return handleCreate(io, exec, { repoRoot, slice: arg, base: values.base, json: values.json });
    case "list":
      return handleList(io, exec, values.json);
    case "remove":
      if (arg === undefined) {
        io.stderr("usage: loop worktree remove <path>\n");
        return ExitCode.USAGE;
      }
      return handleRemove(io, exec, arg, values.json);
    default:
      io.stderr("usage: loop worktree <create|list|remove> ...\n");
      return ExitCode.USAGE;
  }
}
