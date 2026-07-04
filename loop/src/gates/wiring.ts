/**
 * Shared scaffolding for CI-wiring pin tests (the BP-021 class): read the
 * wired artifacts AS TEXT, never import them — the pinned files (ci.yml,
 * package manifests, eval corpora) live outside the loop workspace's build
 * graph on purpose.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const wiringRepoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export function readRepoFile(rel: string): string {
  return readFileSync(join(wiringRepoRoot, rel), "utf8");
}
