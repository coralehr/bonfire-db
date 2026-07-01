import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepoRoot } from "../agents/drift.js";
import { checkGuard, checkRatchet, checkRatchetDocDrift, renderRatchetDoc } from "./ratchet.js";

const REPO_ROOT = findRepoRoot(import.meta.url);

/** Scaffold a minimal fake repo root with a KB and optional guard artifacts. */
function scaffold(kbLines: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "ratchet-"));
  mkdirSync(join(root, "loop/memory"), { recursive: true });
  writeFileSync(join(root, "loop/memory/bug-patterns.jsonl"), `${kbLines.join("\n")}\n`);
  return root;
}

function guardedEntry(guard: { type: string; ref: string }): string {
  return JSON.stringify({
    id: "BP-201",
    class: "fixture-class",
    recorded: "2026-07-01",
    symptom: "s",
    rootCause: "r",
    fix: "f",
    status: "guarded",
    guard
  });
}

describe("checkRatchet — the closure invariant fails closed", () => {
  test("the REAL repo closes: KB valid, every guarded entry proven, doc not drifted", () => {
    const r = checkRatchet(REPO_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.violations).toEqual([]);
      expect(r.value.guarded).toBeGreaterThanOrEqual(3);
      expect(checkRatchetDocDrift(REPO_ROOT, r.value.entries)).toBe(true);
    }
  });

  test("a malformed KB is a loud err, never a partial report (T4)", () => {
    const root = scaffold(["{ this is not json"]);
    expect(checkRatchet(root).ok).toBe(false);
  });

  test("a guarded entry whose test guard vanished is a violation (bug reopened)", () => {
    const root = scaffold([guardedEntry({ type: "test", ref: "loop/src/gone.test.ts::case" })]);
    const r = checkRatchet(root);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.ok).toBe(false);
      expect(r.value.violations[0]?.id).toBe("BP-201");
    }
  });

  test("a renamed regression test is caught (file exists, name gone)", () => {
    const root = scaffold([
      guardedEntry({ type: "test", ref: "loop/src/g.test.ts::original name" })
    ]);
    mkdirSync(join(root, "loop/src"), { recursive: true });
    writeFileSync(join(root, "loop/src/g.test.ts"), 'test("renamed", () => {});');
    const r = checkRatchet(root);
    if (r.ok) expect(r.value.violations[0]?.problem).toContain("not found");
    expect(r.ok).toBe(true);
  });

  test("an ast-grep guard without its behaviour test is UNPROVEN (violation)", () => {
    const root = scaffold([guardedEntry({ type: "ast-grep", ref: "sgrules/some-rule.yml" })]);
    mkdirSync(join(root, "sgrules"), { recursive: true });
    writeFileSync(join(root, "sgrules/some-rule.yml"), "id: some-rule");
    const r = checkRatchet(root);
    if (r.ok) expect(r.value.violations[0]?.problem).toContain("unproven");
    expect(r.ok).toBe(true);
  });

  test("a semgrep guard requires its rule id in semgrep.yml", () => {
    const root = scaffold([guardedEntry({ type: "semgrep", ref: "missing-rule-id" })]);
    writeFileSync(join(root, "semgrep.yml"), "rules:\n  - id: other-rule\n");
    const r = checkRatchet(root);
    if (r.ok) expect(r.value.violations[0]?.problem).toContain("missing-rule-id");
    expect(r.ok).toBe(true);
  });
});

describe("checkGuard — ref grammar", () => {
  test("a test ref without '::' is rejected", () => {
    expect(checkGuard(REPO_ROOT, { type: "test", ref: "just-a-file.ts" })).toContain("::");
  });

  test("the real BP-001 guard proves out", () => {
    expect(
      checkGuard(REPO_ROOT, {
        type: "test",
        ref: "loop/src/gates/exec.test.ts::a MISSING tool fails closed"
      })
    ).toBeNull();
  });
});

describe("renderRatchetDoc", () => {
  test("is deterministic and sorted by id", () => {
    const r = checkRatchet(REPO_ROOT);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const a = renderRatchetDoc(r.value.entries);
      const b = renderRatchetDoc([...r.value.entries].reverse());
      expect(a).toBe(b);
      expect(a.indexOf("BP-001")).toBeLessThan(a.indexOf("BP-002"));
    }
  });
});
