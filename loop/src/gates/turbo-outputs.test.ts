/**
 * Ratchet guard BP-016: turbo task output globs must stay inside the
 * workspace's own build directories. A glob like `**\/*.tsbuildinfo` walks
 * THROUGH node_modules workspace symlinks during output capture, and a later
 * cache restore materializes the captured path as a REAL directory over the
 * symlink — shadowing the dependency with an empty husk whose types no longer
 * resolve.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

interface TurboTask {
  outputs?: string[];
}

const turbo = JSON.parse(readFileSync(join(repoRoot, "turbo.json"), "utf8")) as {
  tasks: Record<string, TurboTask>;
};

describe("turbo task outputs", () => {
  test("output globs never start at ** or traverse node_modules (BP-016)", () => {
    const offending: string[] = [];
    for (const [name, task] of Object.entries(turbo.tasks)) {
      for (const glob of task.outputs ?? []) {
        if (glob.startsWith("**") || glob.includes("node_modules")) {
          offending.push(`${name}: ${glob}`);
        }
      }
    }
    expect(offending).toEqual([]);
  });

  test("the task table itself is present (guard is not vacuous)", () => {
    expect(Object.keys(turbo.tasks).length).toBeGreaterThanOrEqual(4);
  });
});
