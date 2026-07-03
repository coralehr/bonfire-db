/**
 * Ratchet guards over the Docker surface (BP-009, BP-010, BP-013).
 *
 * These are regression tripwires, not a compose linter: each test pins one
 * confirmed bug class from the BF-01 run so reintroducing it fails `bun test`.
 *   BP-009 — a hard-coded published host port collided with a local Postgres.
 *   BP-010 — bun's isolated linker produced a node_modules that did not
 *            survive the runtime stage's single-directory COPY.
 *   BP-013 — a published port bound 0.0.0.0, exposing the dev api beyond
 *            loopback.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
const apiDockerfile = readFileSync(join(repoRoot, "docker", "api.Dockerfile"), "utf8");

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
});
