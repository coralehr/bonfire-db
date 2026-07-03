import { describe, expect, test } from "bun:test";
import { findRepoRoot } from "../agents/drift.js";
import { parseBugPatterns, readBugPatterns } from "./bug-pattern.js";

const VALID_GUARDED = JSON.stringify({
  id: "BP-101",
  class: "example-class",
  recorded: "2026-07-01",
  symptom: "s",
  rootCause: "r",
  fix: "f",
  status: "guarded",
  guard: { type: "test", ref: "loop/src/x.test.ts::case" }
});

const VALID_OPEN = JSON.stringify({
  id: "BP-102",
  class: "other-class",
  recorded: "2026-07-01",
  symptom: "s",
  rootCause: "r",
  fix: "f",
  status: "open",
  plannedGuard: "eval: future"
});

describe("parseBugPatterns — strict loader (T4)", () => {
  test("valid guarded + open entries parse", () => {
    const r = parseBugPatterns(`${VALID_GUARDED}\n${VALID_OPEN}\n`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(2);
  });

  test("a non-JSON line fails loudly with its line number", () => {
    const r = parseBugPatterns(`${VALID_GUARDED}\nnot json\n`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues[0]).toContain("line 2");
  });

  test("guarded without a guard is rejected (status must be earned)", () => {
    const bad = VALID_GUARDED.replace(
      ',"guard":{"type":"test","ref":"loop/src/x.test.ts::case"}',
      ""
    );
    expect(parseBugPatterns(`${bad}\n`).ok).toBe(false);
  });

  test("open without a plannedGuard is rejected (debt must be named)", () => {
    const bad = VALID_OPEN.replace(',"plannedGuard":"eval: future"', "");
    expect(parseBugPatterns(`${bad}\n`).ok).toBe(false);
  });

  test("open WITH a guard is rejected (close it instead)", () => {
    const bad = VALID_OPEN.replace(
      '"plannedGuard":"eval: future"',
      '"plannedGuard":"x","guard":{"type":"test","ref":"a.ts::b"}'
    );
    expect(parseBugPatterns(`${bad}\n`).ok).toBe(false);
  });

  test("duplicate ids are rejected", () => {
    const r = parseBugPatterns(`${VALID_GUARDED}\n${VALID_GUARDED}\n`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.join(" ")).toContain("duplicate id");
  });

  test("a malformed id pattern is rejected", () => {
    expect(parseBugPatterns(`${VALID_GUARDED.replace("BP-101", "BUG-1")}\n`).ok).toBe(false);
  });
});

describe("the real KB", () => {
  test("loads, is strict-valid, and carries the seeded incident classes", () => {
    const r = readBugPatterns(findRepoRoot(import.meta.url));
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 8 seeded classes (BP-001..008) + 6 from the BF-01 run (BP-009..014).
      // Deliberately pinned: growing the KB means growing this expectation.
      expect(r.value).toHaveLength(14);
      const classes = r.value.map((e) => e.class);
      expect(classes).toContain("gate-crash-read-as-pass");
      expect(classes).toContain("cross-tenant-leak");
      expect(classes).toContain("fail-open-authz");
      expect(classes).toContain("raw-db-client-bypasses-tenant-boundary");
      expect(classes).toContain("rls-guc-cast-error-channel");
    }
  });
});
