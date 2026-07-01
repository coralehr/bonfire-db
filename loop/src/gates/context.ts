/**
 * The production gate context: deterministic env + the real command runner.
 *
 * The env kills telemetry/network and forces real execution — `TURBO_FORCE`
 * guarantees the authoritative run reflects a genuine gate execution, never a
 * stale Turbo cache replay that could report a false pass (research F8).
 */
import { makeRunner } from "./exec.js";
import type { GateContext } from "./gate.js";

export const GATE_ENV: Readonly<Record<string, string>> = {
  DO_NOT_TRACK: "1",
  TURBO_TELEMETRY_DISABLED: "1",
  TURBO_FORCE: "1",
  CI: "1"
};

export function makeGateContext(repoRoot: string): GateContext {
  const env: Record<string, string | undefined> = { ...process.env, ...GATE_ENV };
  return { repoRoot, env, exec: makeRunner(repoRoot, env) };
}
