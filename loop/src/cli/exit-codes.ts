/**
 * The `loop` exit-code contract (research: small, stable, honoured enum).
 *
 * A verification harness's exit code is load-bearing — CI and agents branch on
 * it — so the categories are fixed and documented in one place. Kept in the low
 * single digits (well under the 126+ shell-reserved range).
 */
export const ExitCode = {
  /** Success — all blocking gates passed / the operation succeeded. */
  OK: 0,
  /** The requested operation reported failure (a gate went red, a git op failed). */
  FAILURE: 1,
  /** Usage error — unknown subcommand, bad or missing flags. */
  USAGE: 2,
  /** Internal harness error — an unexpected exception in `loop` itself. */
  INTERNAL: 3
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
