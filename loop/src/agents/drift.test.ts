import { describe, expect, test } from "bun:test";
import { checkAgentDrift, findRepoRoot } from "./drift.js";

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
