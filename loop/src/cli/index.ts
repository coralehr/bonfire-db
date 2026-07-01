/**
 * Public surface of the `loop` CLI (H3).
 */
export { runGateCommand } from "./commands/gate.js";
export { runWorktreeCommand } from "./commands/worktree.js";
export { ExitCode } from "./exit-codes.js";
export type { CliIO } from "./io.js";
export { main } from "./main.js";
export type { GateReportJson } from "./render.js";
export { renderReportHuman, reportToJson } from "./render.js";
export { resolveRepoRoot } from "./repo.js";
