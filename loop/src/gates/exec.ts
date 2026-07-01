/**
 * The fail-CLOSED command primitive (loop-harness-plan.md T1).
 *
 * `runCommand` collapses every failure shape — a spawn error, a non-zero exit, a
 * signal kill — into `ok: false`, so a crashed or missing tool fails the run
 * instead of silently greenlighting it. Uses `node:child_process` (portable),
 * matching the rest of the harness rather than the Bun global.
 */
import { spawnSync } from "node:child_process";

/** The outcome of running one command. `ok` is true only on a clean exit 0. */
export interface CommandResult {
  readonly ok: boolean;
  readonly exitCode: number;
  /** Combined stdout+stderr, trimmed — the detail surfaced on failure. */
  readonly output: string;
  /** Set iff the process could not be spawned or was killed (never a pass). */
  readonly spawnError: string | null;
}

export interface RunCommandOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

// Conventional "command not found"; any non-zero here means FAIL, never pass.
const SPAWN_FAILURE_EXIT = 127;
const MAX_OUTPUT_BYTES = 67_108_864; // 64 MiB

/** Run one command synchronously, fail-closed. Never throws for a tool failure. */
export function runCommand(argv: readonly string[], options: RunCommandOptions): CommandResult {
  const [command, ...args] = argv;
  if (command === undefined) {
    return { ok: false, exitCode: SPAWN_FAILURE_EXIT, output: "", spawnError: "empty command" };
  }
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES
  });
  if (result.error) {
    // Tool missing / not executable / spawn crash — fail closed, never a pass.
    return {
      ok: false,
      exitCode: SPAWN_FAILURE_EXIT,
      output: "",
      spawnError: result.error.message
    };
  }
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.status === null) {
    const signal = result.signal ?? "unknown";
    return {
      ok: false,
      exitCode: SPAWN_FAILURE_EXIT,
      output,
      spawnError: `killed by signal ${signal}`
    };
  }
  return { ok: result.status === 0, exitCode: result.status, output, spawnError: null };
}

/** A bound command runner (cwd + env fixed); injected into gates so they are testable. */
export type CommandRunner = (argv: readonly string[]) => CommandResult;

/** Build the real runner bound to a repo root and environment. */
export function makeRunner(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>
): CommandRunner {
  return (argv) => runCommand(argv, { cwd, env });
}

/** The detail to surface for a failed command: its output, else its spawn error, else a fallback. */
export function commandDetail(result: CommandResult, fallback: string): string {
  if (result.output.length > 0) return result.output;
  if (result.spawnError !== null && result.spawnError.length > 0) return result.spawnError;
  return fallback;
}

/** A one-line reason for a failed command: `could not run (...)` or `exit N`. */
export function failureReason(result: CommandResult): string {
  if (result.spawnError !== null) return `could not run (${result.spawnError})`;
  return `exit ${String(result.exitCode)}`;
}
