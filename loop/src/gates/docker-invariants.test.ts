/**
 * Ratchet guards over the Docker surface (BP-009, BP-010, BP-013, BP-023).
 *
 * These are regression tripwires, not a compose linter: each test pins one
 * confirmed bug class from a slice run so reintroducing it fails `bun test`.
 *   BP-009 — a hard-coded published host port collided with a local Postgres.
 *   BP-010 — bun's isolated linker produced a node_modules that did not
 *            survive the runtime stage's single-directory COPY.
 *   BP-013 — a published port bound 0.0.0.0, exposing the dev api beyond
 *            loopback.
 *   BP-023 — a new bun workspace was added to the root package.json but its
 *            manifest was not COPYed into the api image, so `bun install
 *            --frozen-lockfile` failed with "Workspace not found" — invisible
 *            locally (cached image), red only on a fresh CI build.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
const apiDockerfile = readFileSync(join(repoRoot, "docker", "api.Dockerfile"), "utf8");
const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  workspaces?: string[];
};

/**
 * Concrete workspace directories from the root globs. Glob patterns
 * (`packages/*`) are expanded against the real filesystem: `bun install
 * --frozen-lockfile` needs EVERY member's manifest present in the image, so a
 * glob-added workspace (the BF-04 `packages/sql-on-fhir` case) must be caught
 * exactly like a literally-listed one — skipping globs re-opened BP-023.
 */
function workspaceDirs(): string[] {
  const dirs: string[] = [];
  for (const pattern of rootPkg.workspaces ?? []) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -"/*".length);
      for (const entry of readdirSync(join(repoRoot, parent), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (existsSync(join(repoRoot, parent, entry.name, "package.json"))) {
          dirs.push(`${parent}/${entry.name}`);
        }
      }
      continue;
    }
    dirs.push(pattern);
  }
  return dirs;
}

/** Every `- "..."` list item inside a `ports:` block, quoted or not. */
function publishedPorts(composeText: string): string[] {
  const entries: string[] = [];
  let portsIndent: number | null = null;
  for (const line of composeText.split("\n")) {
    const portsKey = /^(\s*)ports:\s*$/.exec(line);
    if (portsKey !== null) {
      portsIndent = portsKey[1].length;
      continue;
    }
    if (portsIndent === null) continue;
    const item = /^(\s*)-\s*"?([^"#\s]+)"?\s*$/.exec(line);
    if (item !== null && item[1].length > portsIndent) {
      entries.push(item[2]);
      continue;
    }
    if (/^\s*#/.test(line)) continue;
    portsIndent = null;
  }
  return entries;
}

const ports = publishedPorts(compose);

describe("docker-compose published ports", () => {
  test("the compose file publishes at least the db and api ports", () => {
    expect(ports.length).toBeGreaterThanOrEqual(2);
  });

  test("published host ports are env-overridable — never hard-coded (BP-009)", () => {
    for (const entry of ports) {
      expect(entry).toMatch(/^[^:]+:\$\{[A-Z][A-Z0-9_]*:-\d+\}:\d+$/);
    }
  });

  test("published host ports bind loopback only (BP-013)", () => {
    for (const entry of ports) {
      expect(entry.startsWith("127.0.0.1:")).toBe(true);
    }
  });
});

describe("api image install", () => {
  test("api image bun install uses the hoisted linker (BP-010)", () => {
    const installLines = apiDockerfile
      .split("\n")
      .filter((line) => /^\s*RUN\s+bun install\b/.test(line));
    expect(installLines.length).toBeGreaterThanOrEqual(1);
    for (const line of installLines) {
      expect(line).toContain("--linker hoisted");
    }
  });

  test("every root workspace manifest (globs expanded) is COPYed for install (BP-023)", () => {
    const missing = workspaceDirs().filter(
      (dir) => !apiDockerfile.includes(`COPY ${dir}/package.json ${dir}/package.json`)
    );
    expect(missing).toEqual([]);
  });
});
