/**
 * Ratchet guard BP-031 (dist-dependent-lint-resolution): typed eslint was green
 * locally but red in CI because package-name imports of @bonfire/* resolved via
 * the exports map to dist/index.d.ts — present locally after a build, absent in
 * CI's no-build lint job — collapsing the type graph to error-typed only in CI.
 *
 * Root-cause fix: a namespaced `@bonfire/source` export condition (first in every
 * internal package's exports map) + `customConditions` in tsconfig.base, so tsc
 * and typescript-eslint's projectService always resolve @bonfire/* to src whether
 * or not dist exists. This pins BOTH halves and proves the resolution live:
 *   - with the condition -> resolves to packages/<pkg>/src (dist-independent);
 *   - without it (the pre-fix state) -> resolves to dist (the built-in inversion).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const baseTsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.base.json"), "utf8")) as {
  compilerOptions: { customConditions?: string[] };
};

const CONDITION = "@bonfire/source";
const consumer = join(repoRoot, "packages", "sql-on-fhir", "src", "index.ts");

function resolve(customConditions: string[] | undefined): string | undefined {
  const options: ts.CompilerOptions = {
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    ...(customConditions ? { customConditions } : {})
  };
  return ts.resolveModuleName("@bonfire/core", consumer, options, ts.sys).resolvedModule
    ?.resolvedFileName;
}

describe("BP-031: @bonfire/* type resolution is dist-independent", () => {
  test("tsconfig.base declares the @bonfire/source custom condition", () => {
    expect(baseTsconfig.compilerOptions.customConditions).toContain(CONDITION);
  });

  test("with the condition, @bonfire/core resolves to src (never dist)", () => {
    const resolved = resolve([CONDITION]);
    expect(resolved).toBeDefined();
    expect(resolved).toMatch(/packages[/\\]core[/\\]src[/\\]index\.ts$/);
    expect(resolved).not.toMatch(/dist/);
  });

  test("without the condition it would resolve to dist (the condition is load-bearing)", () => {
    // The pre-fix state — this is why lint diverged from local to CI.
    expect(resolve(undefined)).toMatch(/dist/);
  });
});
