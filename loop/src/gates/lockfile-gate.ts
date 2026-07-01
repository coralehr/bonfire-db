/**
 * The lockfile-drift gate (research gap F5).
 *
 * `bun install --frozen-lockfile` is the primary drift signal: if `package.json`
 * references a dependency `bun.lock` cannot satisfy, the frozen install fails.
 * Belt-and-braces for oven-sh/bun#24223 (frozen install sometimes passing on
 * drift): assert the install left `bun.lock` byte-identical. We diff only
 * `bun.lock` — a dirty `package.json` is the developer's own in-progress edit,
 * not lockfile drift — so the gate is meaningful on a committed worktree without
 * false-positiving on local work.
 */
import { commandDetail, failureReason } from "./exec.js";
import type { Gate } from "./gate.js";

export const LOCKFILE_GATE: Gate = {
  name: "lockfile",
  stage: 1,
  tier: "blocking",
  run: (ctx) => {
    const install = ctx.exec(["bun", "install", "--frozen-lockfile"]);
    if (!install.ok) {
      return {
        status: "fail",
        summary: `lockfile failed — frozen install rejected (${failureReason(install)})`,
        detail: commandDetail(install, "(no output)")
      };
    }
    const diff = ctx.exec(["git", "diff", "--exit-code", "--", "bun.lock"]);
    if (diff.ok) {
      return { status: "pass", summary: "lockfile passed — bun.lock consistent", detail: "" };
    }
    return {
      status: "fail",
      summary: "lockfile failed — bun.lock changed by a frozen install (stale lockfile)",
      detail: commandDetail(diff, "(no output)")
    };
  }
};
