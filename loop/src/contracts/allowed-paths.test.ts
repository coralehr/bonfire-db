import { describe, expect, test } from "bun:test";
import { checkAllowedPaths } from "./allowed-paths.js";
import type { SliceContract } from "./slice-contract.js";
import { makeSlice } from "./slice-fixture.js";

function slice(allowedPaths: string[], forbiddenPaths: string[] = []): SliceContract {
  return makeSlice({ allowedPaths, forbiddenPaths });
}

describe("checkAllowedPaths — in/out of scope", () => {
  test("in-scope files pass (ok branch)", () => {
    const r = checkAllowedPaths(slice(["drizzle/**", "packages/core/src/**"]), [
      "packages/core/src/db.ts",
      "drizzle/0001_init.sql"
    ]);
    expect(r.ok).toBe(true);
  });

  test("empty changeset is vacuously ok", () => {
    expect(checkAllowedPaths(slice(["packages/**"]), []).ok).toBe(true);
  });

  test("a file matching nothing is a default-deny violation", () => {
    const r = checkAllowedPaths(slice(["packages/**"]), ["README.md"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.violations[0]?.file).toBe("README.md");
      expect(r.error.violations[0]?.reason).toContain("default-deny");
    }
  });

  test("a slice-forbidden path is rejected even when also allowed (forbidden wins)", () => {
    const r = checkAllowedPaths(slice(["packages/**"], ["packages/core/legacy/**"]), [
      "packages/core/legacy/x.ts"
    ]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.violations[0]?.reason).toContain("forbidden");
  });

  test("multiple violations accumulate", () => {
    const r = checkAllowedPaths(slice(["packages/**"]), ["apps/a.ts", "apps/b.ts"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.violations).toHaveLength(2);
  });
});

describe("checkAllowedPaths — global forbidden floor (structural default-deny)", () => {
  // A maker must not reach the gates/harness/CI/secrets even with allowedPaths ['**'].
  const floorHits = [
    ".github/workflows/ci.yml",
    "loop/src/contracts/slice-contract.ts",
    "eslint.config.ts",
    "semgrep.yml",
    ".gitleaks.toml",
    ".dependency-cruiser.cjs",
    "tsconfig.base.json",
    ".env",
    ".env.local",
    ".envrc",
    "fixtures/sql-on-fhir/MANIFEST.json"
  ];
  for (const file of floorHits) {
    test(`floor forbids ${file} even under allow '**'`, () => {
      expect(checkAllowedPaths(slice(["**"]), [file]).ok).toBe(false);
    });
  }

  test(".env.example is allowed (deliberately carved out of the secret floor)", () => {
    expect(checkAllowedPaths(slice([".env.example"]), [".env.example"]).ok).toBe(true);
  });

  test("dot:true — a forbidden ** catches a hidden segment (fixtures/private/.secret)", () => {
    expect(checkAllowedPaths(slice(["**"]), ["fixtures/private/.secret"]).ok).toBe(false);
  });

  test("real data under a real*-named directory is caught (not just basename)", () => {
    expect(checkAllowedPaths(slice(["seed/**"]), ["seed/realdir/data.json"]).ok).toBe(false);
  });
});

describe("checkAllowedPaths — path normalization", () => {
  test("leading ./ is stripped, not a silent mismatch", () => {
    expect(checkAllowedPaths(slice(["packages/**"]), ["./packages/core/x.ts"]).ok).toBe(true);
  });

  test("an absolute path is rejected", () => {
    const r = checkAllowedPaths(slice(["**"]), ["/etc/passwd"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.violations[0]?.reason).toContain("absolute");
  });

  test("a .. traversal is rejected", () => {
    const r = checkAllowedPaths(slice(["**"]), ["packages/../../etc/passwd"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.violations[0]?.reason).toContain("traversal");
  });

  test("a backslash separator is rejected", () => {
    const r = checkAllowedPaths(slice(["**"]), ["packages\\core\\x.ts"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.violations[0]?.reason).toContain("backslash");
  });
});
