/** Public surface of the `@bonfire/loop` harness package. */

export const LOOP_PACKAGE = "@bonfire/loop" as const;

export type LoopPackage = typeof LOOP_PACKAGE;

export interface LoopManifest {
  readonly name: LoopPackage;
  readonly version: string;
}

export function loopManifest(version: string): LoopManifest {
  return { name: LOOP_PACKAGE, version };
}

export * from "./agents/index.js";
export * from "./cli/index.js";
export * from "./contracts/index.js";
export * from "./gates/index.js";
export * from "./worktree/index.js";
