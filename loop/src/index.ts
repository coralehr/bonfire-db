/** Public surface of the `@bonfire/loop` harness package (placeholder). */

export const LOOP_PACKAGE = "@bonfire/loop" as const;

export type LoopPackage = typeof LOOP_PACKAGE;

export interface LoopManifest {
  readonly name: LoopPackage;
  readonly version: string;
}

export function loopManifest(version: string): LoopManifest {
  return { name: LOOP_PACKAGE, version };
}
