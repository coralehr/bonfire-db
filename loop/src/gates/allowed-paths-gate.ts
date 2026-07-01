/**
 * The allowed-paths gate: enforce a slice's write scope on its actual diff.
 *
 * This is the deterministic form of "the maker stayed in its lane" — it reuses
 * the H1 checker (`checkAllowedPaths`, default-deny + the global gate/secrets
 * floor) against the files the branch actually changed vs `base`. Because the
 * global floor forbids editing any gate config, this same gate is what stops an
 * agent from weakening the gates that grade it (the top worktree risk in the
 * research). Only added to the run when a slice id is supplied.
 */
import { checkAllowedPaths } from "../contracts/allowed-paths.js";
import { getSlice } from "../contracts/registry.js";
import { commandDetail, failureReason } from "./exec.js";
import type { Gate } from "./gate.js";

/** Changed files on the branch vs `base` (three-dot: changes since the merge-base). */
export function makeAllowedPathsGate(sliceId: string, base: string): Gate {
  return {
    name: "allowed-paths",
    stage: 1,
    tier: "blocking",
    run: (ctx) => {
      const slice = getSlice(sliceId);
      if (!slice) {
        return {
          status: "fail",
          summary: `allowed-paths failed — unknown slice ${sliceId}`,
          detail: `no slice '${sliceId}' in the registry`
        };
      }
      const diff = ctx.exec(["git", "diff", "--name-only", `${base}...HEAD`]);
      if (!diff.ok) {
        return {
          status: "fail",
          summary: `allowed-paths failed — git diff ${failureReason(diff)}`,
          detail: commandDetail(diff, "(no output)")
        };
      }
      const files = diff.output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const result = checkAllowedPaths(slice, files);
      if (result.ok) {
        return {
          status: "pass",
          summary: `allowed-paths passed — ${String(files.length)} changed file(s) in scope`,
          detail: ""
        };
      }
      const detail = result.error.violations.map((v) => `${v.file}: ${v.reason}`).join("\n");
      const count = String(result.error.violations.length);
      return {
        status: "fail",
        summary: `allowed-paths failed — ${count} out-of-scope file(s) for ${sliceId}`,
        detail
      };
    }
  };
}
