/**
 * Ratchet guard BP-022 (phi-tripwire-scope-narrow): the PHI scanner used to sweep
 * a hardcoded allowlist of roots+extensions, so a .csv, a new fixtures dir, or a
 * PHI literal in seed/tests/docs went uncovered. It is now DENY-BY-DEFAULT — every
 * tracked text file minus a reviewed carve-out.
 *
 * This pins that structurally: the set of tracked text files NOT swept must equal
 * exactly the EXCLUDED_PATHS carve-out (plus binaries). Any new directory,
 * extension, or fixture corpus is therefore covered automatically, and shrinking
 * coverage forces an edit to the reviewed exclude list (which every carve-out
 * entry must justify with a reason). Runs in the CI `build-test / test` check.
 *
 * The scanner lives under scripts/ (outside the loop build graph), so coverage is
 * read via its --list-targets mode and the config via text, never imported.
 */

import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readRepoFile as read } from "./wiring.js";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();

function gitLsFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter((f) => f.length > 0);
}

function sweptTargets(): string[] {
  return execFileSync("bun", ["scripts/synthetic-scan/index.ts", "--list-targets"], {
    cwd: repoRoot,
    encoding: "utf8"
  })
    .split("\n")
    .filter((f) => f.length > 0);
}

/** The `path:` values declared in a config carve-out array. */
function carveOutPaths(arrayName: string): string[] {
  const config = read("scripts/synthetic-scan/config.ts");
  const block = new RegExp(`${arrayName}[\\s\\S]*?\\n\\];`).exec(config)?.[0] ?? "";
  return [...block.matchAll(/path:\s*"([^"]+)"/g)].map((m) => m[1] as string);
}

function underAny(rel: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => rel === p || rel.startsWith(`${p}/`));
}

describe("BP-022: PHI scanner coverage is deny-by-default", () => {
  test("every tracked text file is swept except the reviewed EXCLUDED_PATHS", () => {
    const excluded = carveOutPaths("EXCLUDED_PATHS");
    expect(excluded.length).toBeGreaterThan(0);
    const swept = new Set(sweptTargets());
    const tracked = gitLsFiles();
    // A file may be unswept only because it is under a carve-out or is binary
    // (null-byte). Binary files are rare here; treat any non-carve-out miss as a
    // coverage hole to investigate.
    const holes = tracked.filter(
      // exists on disk (a locally deleted-but-unstaged path is skipped by the
      // scanner too), not swept, and not under a reviewed carve-out.
      (f) => existsSync(join(repoRoot, f)) && !swept.has(f) && !underAny(f, excluded)
    );
    // Binary files legitimately drop out; assert none are source-shaped leaks.
    const suspicious = holes.filter((f) => /\.(json|ndjson|csv|md|sql|ts|tsx|txt|ya?ml)$/.test(f));
    expect(
      suspicious,
      `uncovered text files (not under EXCLUDED_PATHS): ${suspicious.join(", ")}`
    ).toEqual([]);
  });

  test("sensitive dirs are actually swept (coverage is real, not vacuous)", () => {
    const swept = sweptTargets();
    for (const dir of ["seed", "fixtures/synthetic"]) {
      expect(
        swept.some((f) => f.startsWith(`${dir}/`)),
        `${dir} is swept`
      ).toBe(true);
    }
  });

  test("every carve-out entry carries a reason (no silent exclusions)", () => {
    const config = read("scripts/synthetic-scan/config.ts");
    for (const arrayName of ["EXCLUDED_PATHS", "FIELD_AWARE_EXEMPT"]) {
      const block = new RegExp(`${arrayName}[\\s\\S]*?\\n\\];`).exec(config)?.[0] ?? "";
      const paths = [...block.matchAll(/path:\s*"/g)].length;
      const reasons = [...block.matchAll(/reason:\s*"[^"]+"/g)].length;
      expect(reasons, `${arrayName}: every path needs a reason`).toBe(paths);
    }
  });

  test("the scanner's own internals are on the global forbidden floor (BP-022)", () => {
    expect(read("loop/src/contracts/allowed-paths.ts")).toContain('"scripts/synthetic-scan/**"');
  });
});
