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
  // The KB is a monotonic ledger — it only grows. A ratchet must never SHRINK,
  // so the invariant is a floor (below which a class was silently dropped) plus
  // an explicit roll-call of load-bearing classes that must always be present.
  // An exact-count pin was pure friction (every new entry forced a bump) and
  // caught nothing a shrink-floor + roll-call doesn't. Raise SEEDED_FLOOR only
  // when you intend to make a past class undeleteable — never to chase a count.
  const SEEDED_FLOOR = 25;
  const LOAD_BEARING_CLASSES = [
    "gate-crash-read-as-pass",
    "cross-tenant-leak",
    "fail-open-authz",
    "raw-db-client-bypasses-tenant-boundary",
    "rls-guc-cast-error-channel",
    "jsonb-param-double-encode",
    "unique-constraint-existence-oracle",
    "sql-gate-denylist-evasion",
    "lossy-fhir",
    "network-on-validate-write-path"
  ];

  test("loads, is strict-valid, never shrinks, and keeps the load-bearing classes", () => {
    const r = readBugPatterns(findRepoRoot(import.meta.url));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.length).toBeGreaterThanOrEqual(SEEDED_FLOOR);
      const classes = new Set(r.value.map((e) => e.class));
      const missing = LOAD_BEARING_CLASSES.filter((klass) => !classes.has(klass));
      expect(missing).toEqual([]);
    }
  });
});
