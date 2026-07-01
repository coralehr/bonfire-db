import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentDefs } from "./agents.js";
import { checkAgentDrift, findRepoRoot } from "./drift.js";
import { generateFiles } from "./generate.js";

/**
 * The round-trip guard: the committed `.claude/agents/*.md` and
 * `.codex/agents/*.toml` files MUST equal what the generator produces from the
 * agent defs. If this fails, run `bun run gen:agents` and commit the result.
 */
describe("checkAgentDrift — committed files match the single source", () => {
  test("no drift against the real repo files", () => {
    const repoRoot = findRepoRoot(import.meta.url);
    const result = checkAgentDrift(repoRoot);
    if (!result.ok) {
      const paths = result.error.drifted.map((file) => file.path).join(", ");
      throw new Error(`agent files drifted (run gen:agents): ${paths}`);
    }
    expect(result.ok).toBe(true);
  });
});

describe("checkAgentDrift — failure paths (injected into a temp tree)", () => {
  function seed(): string {
    const root = mkdtempSync(join(tmpdir(), "bonfire-drift-"));
    for (const file of generateFiles(agentDefs)) {
      const absolute = join(root, file.path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, file.content);
    }
    return root;
  }

  test("a faithful temp copy has no drift", () => {
    const root = seed();
    expect(checkAgentDrift(root).ok).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("a mutated byte is reported as drift", () => {
    const root = seed();
    const target = generateFiles(agentDefs)[0]!;
    writeFileSync(join(root, target.path), `${target.content}// tampered`);
    const result = checkAgentDrift(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.drifted.some((d) => d.path === target.path)).toBe(true);
    }
    rmSync(root, { recursive: true, force: true });
  });

  test("a missing generated file is reported as drift", () => {
    const root = seed();
    const target = generateFiles(agentDefs)[0]!;
    rmSync(join(root, target.path));
    expect(checkAgentDrift(root).ok).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("an orphan generated file (no longer in the source) is reported as drift", () => {
    const root = seed();
    const orphan = ".claude/agents/bonfire-ghost.md";
    writeFileSync(join(root, orphan), "stale agent");
    const result = checkAgentDrift(root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.drifted.some((d) => d.path === orphan)).toBe(true);
    }
    rmSync(root, { recursive: true, force: true });
  });
});
