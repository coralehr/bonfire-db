/**
 * The drift guard: prove the committed `.claude`/`.codex` files still equal the
 * single source. This is the whole point of generating both formats (H2): if a
 * human hand-edits one editor's file, or a def changes without re-running the
 * writer, the on-disk bytes diverge from `generateFiles(agentDefs)` and the check
 * fails. Comparison is byte-for-byte; a missing file is drift too.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Result } from "../contracts/result.js";
import { err, ok } from "../contracts/result.js";
import { agentDefs } from "./agents.js";
import { generateFiles } from "./generate.js";

/** A single drifted (mismatched or missing) generated file. */
export interface DriftedFile {
  readonly path: string;
}

/** The failure payload: every generated file that no longer matches the source. */
export interface DriftFailure {
  readonly drifted: readonly DriftedFile[];
}

/**
 * Resolve the repo root from a module URL by walking up to the first ancestor
 * that holds BOTH a `package.json` and a `.git` entry. In this monorepo that
 * uniquely identifies the bonfire-db root from anywhere inside `loop/`: the
 * `loop/` package has a `package.json` but no `.git`, and the parent workspace
 * has a `.git` but no `package.json`. The `.git` entry is checked with
 * `existsSync`, which is true for both a normal checkout (directory) and a git
 * worktree (file), so this also resolves correctly inside per-agent worktrees.
 */
export function findRepoRoot(fromUrl: string): string {
  let dir = dirname(fileURLToPath(fromUrl));
  for (;;) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("could not locate repo root (no package.json + .git ancestor)");
    }
    dir = parent;
  }
}

/**
 * Compare every generated agent file against its on-disk counterpart under
 * `repoRoot`. Returns `ok` when all match byte-for-byte, otherwise the list of
 * drifted (mismatched or missing) paths. Recoverable, so it returns a Result.
 */
export function checkAgentDrift(repoRoot: string): Result<{ readonly ok: true }, DriftFailure> {
  const expected = generateFiles(agentDefs);
  const expectedPaths = new Set(expected.map((file) => file.path));
  const drifted: DriftedFile[] = [];

  // Forward: every generated file must exist on disk and match byte-for-byte.
  for (const file of expected) {
    const absolute = join(repoRoot, file.path);
    if (!existsSync(absolute)) {
      drifted.push({ path: file.path });
      continue;
    }
    const onDisk = readFileSync(absolute);
    if (!onDisk.equals(Buffer.from(file.content, "utf8"))) {
      drifted.push({ path: file.path });
    }
  }

  // Reverse: an ORPHAN generated file on disk (no longer produced by any def,
  // e.g. a renamed/removed agent) is drift too — otherwise it lingers, stale.
  for (const [dir, ext] of [
    [".claude/agents", ".md"],
    [".codex/agents", ".toml"]
  ] as const) {
    const absDir = join(repoRoot, dir);
    if (!existsSync(absDir)) {
      continue;
    }
    for (const name of readdirSync(absDir)) {
      if (!name.endsWith(ext)) {
        continue;
      }
      const rel = `${dir}/${name}`;
      if (!expectedPaths.has(rel)) {
        drifted.push({ path: rel });
      }
    }
  }

  return drifted.length > 0 ? err({ drifted }) : ok({ ok: true });
}
