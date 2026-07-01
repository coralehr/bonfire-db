/**
 * `loop` command dispatch — the imperative shell.
 *
 * Peels the subcommand off argv, routes to a handler, and returns an exit code
 * (never calls process.exit — that is the bin's job, keeping `main` testable).
 * Any unexpected throw becomes exit 3 (internal), so a harness bug is loud, not a
 * silent zero.
 */
import { runGateCommand } from "./commands/gate.js";
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

global:
  --help, -h     show this help
  --version, -v  print the version
`;

export function main(argv: readonly string[], io: CliIO): number {
  try {
    const [subcommand, ...rest] = argv;

    if (
      subcommand === undefined ||
      subcommand === "help" ||
      subcommand === "--help" ||
      subcommand === "-h"
    ) {
      io.stdout(HELP);
      return ExitCode.OK;
    }
    if (subcommand === "--version" || subcommand === "-v") {
      io.stdout(`loop ${VERSION}\n`);
      return ExitCode.OK;
    }

    switch (subcommand) {
      case "gate":
        return runGateCommand(io, rest);
      case "worktree":
        return runWorktreeCommand(io, rest);
      default:
        io.stderr(`loop: unknown command '${subcommand}'\n\n${HELP}`);
        return ExitCode.USAGE;
    }
  } catch (error) {
    io.stderr(`loop: internal error — ${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.INTERNAL;
  }
}
