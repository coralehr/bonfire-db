/**
 * Ratchet guard BP-025: every synthetic fixture the seed manifest lists must be
 * GIT-TRACKED. A broad `*.ndjson` ignore in .gitignore (a PHI-safety default)
 * silently swallowed the committed corpus — the files existed locally so the
 * seed passed, but they were absent on a fresh CI checkout and the seed
 * crashed with ENOENT. This test fails fast (no DB, no docker) the moment a
 * manifest-listed fixture is untracked or ignored.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const MANIFEST = "fixtures/synthetic/corpus.manifest.json";

interface Manifest {
  files: { path: string }[];
}

const manifest = JSON.parse(readFileSync(join(repoRoot, MANIFEST), "utf8")) as Manifest;

/** Files git currently tracks under fixtures/synthetic (empty on git failure). */
function trackedFixtureFiles(): Set<string> {
  const proc = Bun.spawnSync(["git", "ls-files", "fixtures/synthetic"], { cwd: repoRoot });
  if (proc.exitCode !== 0) return new Set();
  return new Set(
    proc.stdout
      .toString()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  );
}

describe("synthetic fixture corpus is committed", () => {
  const tracked = trackedFixtureFiles();

  test("git tracks fixtures/synthetic (sanity: the check can see files)", () => {
    expect(tracked.size).toBeGreaterThan(0);
  });

  test("every manifest-listed fixture file is git-tracked (BP-025)", () => {
    const untracked = manifest.files
      .map((file) => `fixtures/synthetic/${file.path}`)
      .filter((path) => !tracked.has(path));
    expect(untracked).toEqual([]);
  });
});
