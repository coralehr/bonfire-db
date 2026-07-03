import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evalCaseSchema } from "../contracts/eval-case.js";
import { readEvalCorpus } from "./corpus.js";

function repoRoot(): string {
  // this file: loop/src/evals/corpus.test.ts -> up 4 to repo root
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

describe("eval-case schema", () => {
  test("accepts a well-formed case", () => {
    const r = evalCaseSchema.safeParse({
      id: "bf02-scanner-error-redacts-content",
      slice: "BF-02",
      traces: "BP-017",
      run: { command: ["bun", "loop/src/evals/scanner-redaction.ts"] }
    });
    expect(r.success).toBe(true);
  });

  test("rejects a bad id, a non-BF slice, and an empty command", () => {
    expect(
      evalCaseSchema.safeParse({ id: "BAD", slice: "BF-02", traces: "x", run: { command: ["a"] } })
        .success
    ).toBe(false);
    expect(
      evalCaseSchema.safeParse({
        id: "bf02-x",
        slice: "nope",
        traces: "x",
        run: { command: ["a"] }
      }).success
    ).toBe(false);
    expect(
      evalCaseSchema.safeParse({ id: "bf02-x", slice: "BF-02", traces: "x", run: { command: [] } })
        .success
    ).toBe(false);
  });

  test("is strict — an unknown field is rejected", () => {
    expect(
      evalCaseSchema.safeParse({
        id: "bf02-x",
        slice: "BF-02",
        traces: "x",
        run: { command: ["a"] },
        extra: 1
      }).success
    ).toBe(false);
  });
});

describe("the real eval corpus", () => {
  test("loads, is strict-valid, and carries the BP-017 redaction eval", () => {
    const r = readEvalCorpus(repoRoot());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.length).toBeGreaterThanOrEqual(1);
      const ids = r.value.map((c) => c.id);
      expect(ids).toContain("bf02-scanner-error-redacts-content");
    }
  });
});
