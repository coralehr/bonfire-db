/**
 * `loop` command dispatch — the imperative shell.
 *
 * Peels the subcommand off argv, routes to a handler, and returns an exit code
 * (never calls process.exit — that is the bin's job, keeping `main` testable).
 * Any unexpected throw becomes exit 3 (internal), so a harness bug is loud, not a
 * silent zero.
 */
import { runEvalCommand } from "./commands/eval.js";
import { runGateCommand } from "./commands/gate.js";
import { runRatchetCommand } from "./commands/ratchet.js";
import { runStateCommand } from "./commands/state.js";
import { runWorktreeCommand } from "./commands/worktree.js";
import { ExitCode } from "./exit-codes.js";
import type { CliIO } from "./io.js";

const VERSION = "0.1.0";

const HELP = `loop — the Bonfire DB harness CLI

usage:
  loop gate [--slice <id>] [--base <ref>] [--strict] [--json]
      run the deterministic gate stack (Stage 0 + Stage 1), fail-closed.
      --slice adds the allowed-paths check for that slice's diff vs --base.
      --strict fails the run when a blocking gate could only be skipped.
  loop worktree create <slice> [--base <ref>] [--json]
  loop worktree list [--json]
  loop worktree remove <path> [--json]
      per-agent worktree isolation under .worktrees/.
  loop ratchet [--write] [--json]
      enforce the memory closure invariant: the bug-patterns KB must parse,
      every guarded entry's guard must exist and be proven, and RATCHET.md
      must match the KB. --write regenerates docs/loop/RATCHET.md.
  loop state list [--json]
  loop state set <slice> <inbox|active|done|failed> [--note <text>] [--actor <name>]
      read/append the slice STATE ledger (loop/memory/state.jsonl).
  loop eval [--slice <id>] [--strict] [--json]
      run the Stage-2 execution-watching eval corpus (loop/evals/**),
      fail-closed. --slice runs only that slice's cases.

global:
  --help, -h     show this help
  --version, -v  print the version
`;

type CommandHandler = (io: CliIO, args: readonly string[]) => number;

const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  gate: runGateCommand,
  eval: runEvalCommand,
  worktree: runWorktreeCommand,
  ratchet: runRatchetCommand,
  state: runStateCommand
};

const HELP_FLAGS = new Set(["help", "--help", "-h"]);

export function main(argv: readonly string[], io: CliIO): number {
  try {
    const [subcommand, ...rest] = argv;

    if (subcommand === undefined || HELP_FLAGS.has(subcommand)) {
      io.stdout(HELP);
      return ExitCode.OK;
    }
    if (subcommand === "--version" || subcommand === "-v") {
      io.stdout(`loop ${VERSION}\n`);
      return ExitCode.OK;
    }

    const handler = COMMANDS[subcommand];
    if (handler === undefined) {
      io.stderr(`loop: unknown command '${subcommand}'\n\n${HELP}`);
      return ExitCode.USAGE;
    }
    return handler(io, rest);
  } catch (error) {
    io.stderr(`loop: internal error — ${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.INTERNAL;
  }
}
