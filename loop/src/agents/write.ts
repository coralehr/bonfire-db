/**
 * The agent-file writer: materialize the single source onto disk.
 *
 * Run via `bun run loop/src/agents/write.ts` (the `gen:agents` script). It writes
 * every `generateFiles(agentDefs)` entry under the repo root, creating parent
 * directories as needed, then prints what it wrote. The drift check (./drift.ts)
 * is the inverse: after running this, the committed files match the source, so CI
 * stays green. `writeAgentFiles` is exported (and importable without side effects)
 * so it can be exercised directly; the filesystem write only runs as a script.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDefs } from "./agents.js";
import { findRepoRoot } from "./drift.js";
import { generateFiles } from "./generate.js";

/** Write every generated agent file under `repoRoot`; return the paths written. */
export function writeAgentFiles(repoRoot: string): readonly string[] {
  const written: string[] = [];
  for (const file of generateFiles(agentDefs)) {
    const absolute = join(repoRoot, file.path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content, "utf8");
    written.push(file.path);
  }
  return written;
}

if (import.meta.main) {
  const repoRoot = findRepoRoot(import.meta.url);
  for (const path of writeAgentFiles(repoRoot)) {
    process.stdout.write(`wrote ${path}\n`);
  }
}
