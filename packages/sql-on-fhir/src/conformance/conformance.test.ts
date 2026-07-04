/**
 * Negative controls for the conformance pipeline (fake-conformance danger
 * check): a tampered suite refuses to load, a wrong expectation flips the run
 * red, skip honesty is structural, and the pass counts match an independent
 * recount of the vendored suite files.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConformanceReport, LoadedSuite } from "../index.js";
import { exitCodeForReport, loadSuite, runSuite } from "../index.js";

const SUITE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "sql-on-fhir"
);

function loadRealSuite(): LoadedSuite {
  const suite = loadSuite(SUITE_DIR);
  if (!suite.ok) throw new Error(`suite must load: ${suite.error.message}`);
  return suite.data;
}

function runReal(): ConformanceReport {
  return runSuite(loadRealSuite());
}

/** Copy the suite to a temp dir, mutate it, and assert the load fails closed. */
function expectLoadFailure(mutate: (tmp: string) => void, code: string): void {
  const tmp = mkdtempSync(join(tmpdir(), "bf04-suite-mutation-"));
  try {
    cpSync(SUITE_DIR, tmp, { recursive: true });
    mutate(tmp);
    const result = loadSuite(tmp);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("conformance run (real vendored suite)", () => {
  test("passes every shareable case and declares the rest", () => {
    const report = runReal();
    expect(report.failed).toBe(0);
    // HARD pass floor — not derived from the report's own fields (a derived
    // assertion is tautological when failed === 0). 133 shareable + 11
    // declared-unsupported is the pinned headline; changing either number
    // must be a deliberate, reviewed edit of this test AND the manifest.
    expect(report.passed).toBe(133);
    expect(report.skippedDeclared).toBe(11);
    expect(report.passed).toBe(report.manifestShareableCases);
    expect(exitCodeForReport(report)).toBe(0);
  });

  test("reported total matches an independent recount of the vendored JSON", () => {
    // Independent recount: raw JSON.parse over the tests directory, no loader.
    const names = readdirSync(join(SUITE_DIR, "tests")).filter((f) => f.endsWith(".json"));
    let recount = 0;
    for (const name of names) {
      const parsed = JSON.parse(readFileSync(join(SUITE_DIR, "tests", name), "utf8")) as {
        tests: unknown[];
      };
      recount += parsed.tests.length;
    }
    const report = runReal();
    expect(recount).toBe(144);
    expect(report.total).toBe(recount);
    expect(report.recountedCases).toBe(recount);
    expect(report.passed + report.failed + report.skippedDeclared).toBe(recount);
  });
});

describe("fake-conformance negative controls", () => {
  test("a mutated expectation flips the run red (runner really compares rows)", () => {
    const suite = loadRealSuite();
    const mutated: LoadedSuite = {
      ...suite,
      files: suite.files.map((entry) =>
        entry.name === "basic.json"
          ? {
              name: entry.name,
              file: {
                ...entry.file,
                tests: entry.file.tests.map((suiteCase, index) =>
                  index === 0
                    ? { ...suiteCase, expect: [{ id: "tampered-expectation" }] }
                    : suiteCase
                )
              }
            }
          : entry
      )
    };
    const report = runSuite(mutated);
    expect(report.failed).toBeGreaterThanOrEqual(1);
    expect(exitCodeForReport(report)).toBe(1);
    expect(report.failures.some((f) => f.file === "basic.json")).toBe(true);
  });

  test("a byte-tampered suite copy fails closed on sha256 (never runs)", () => {
    expectLoadFailure((tmp) => {
      const target = join(tmp, "tests", "basic.json");
      const original = readFileSync(target, "utf8");
      writeFileSync(target, original.replace('"pt1"', '"pt9"'), "utf8");
    }, "SUITE_FILE_TAMPERED");
  });

  test("a missing suite file fails closed as a manifest mismatch", () => {
    expectLoadFailure((tmp) => {
      rmSync(join(tmp, "tests", "basic.json"));
    }, "SUITE_MANIFEST_MISMATCH");
  });

  test("an allowlisted case that passes is a failure (stale allowlist)", () => {
    const suite = loadRealSuite();
    const trivialView = {
      resource: "Patient",
      select: [{ column: [{ name: "id", path: "id", type: "id" }] }]
    };
    const declaredButPassing: LoadedSuite = {
      ...suite,
      manifest: {
        ...suite.manifest,
        declaredUnsupported: [
          { file: "basic.json", title: "stale-entry", reason: "pretend unsupported" }
        ]
      },
      files: suite.files.map((entry) =>
        entry.name === "basic.json"
          ? {
              name: entry.name,
              file: {
                ...entry.file,
                tests: [
                  {
                    title: "stale-entry",
                    view: trivialView,
                    expect: [{ id: "pt1" }, { id: "pt2" }, { id: "pt3" }]
                  },
                  ...entry.file.tests.slice(1)
                ]
              }
            }
          : entry
      )
    };
    const report = runSuite(declaredButPassing);
    expect(report.failures.some((f) => f.reason.includes("stale allowlist"))).toBe(true);
    expect(exitCodeForReport(report)).toBe(1);
  });

  test("an allowlist entry matching no case is a failure (no phantom skips)", () => {
    const suite = loadRealSuite();
    const phantom: LoadedSuite = {
      ...suite,
      manifest: {
        ...suite.manifest,
        declaredUnsupported: [
          ...suite.manifest.declaredUnsupported,
          { file: "basic.json", title: "does-not-exist", reason: "phantom" }
        ]
      }
    };
    const report = runSuite(phantom);
    expect(report.failures.some((f) => f.reason.includes("entry matches no vendored case"))).toBe(
      true
    );
    expect(exitCodeForReport(report)).toBe(1);
  });

  test("an undeclared failing case fails the run (no silent skip path exists)", () => {
    const suite = loadRealSuite();
    const withBrokenCase: LoadedSuite = {
      ...suite,
      files: suite.files.map((entry) =>
        entry.name === "basic.json"
          ? {
              name: entry.name,
              file: {
                ...entry.file,
                tests: [
                  ...entry.file.tests,
                  {
                    title: "undeclared-unsupported-feature",
                    view: {
                      resource: "Patient",
                      select: [
                        { column: [{ name: "x", path: "name.family.join(',')", type: "string" }] }
                      ]
                    },
                    expect: [{ x: "F1" }, { x: "F2" }, { x: null }]
                  }
                ]
              }
            }
          : entry
      )
    };
    const report = runSuite(withBrokenCase);
    expect(report.failures.some((f) => f.title === "undeclared-unsupported-feature")).toBe(true);
    expect(exitCodeForReport(report)).toBe(1);
  });
});

describe("conformance-headline drift controls (allowlist cannot absorb regressions)", () => {
  test("downgrading a failing case into declaredUnsupported still exits non-zero (pass floor)", () => {
    const suite = loadRealSuite();
    // Attack shape: regress one shareable case (its expectation no longer
    // matches) AND declare it unsupported, leaving shareableCases at 133.
    const downgraded: LoadedSuite = {
      ...suite,
      manifest: {
        ...suite.manifest,
        declaredUnsupported: [
          ...suite.manifest.declaredUnsupported,
          { file: "basic.json", title: "basic attribute", reason: "quietly regressed" }
        ]
      },
      files: suite.files.map((entry) =>
        entry.name === "basic.json"
          ? {
              name: entry.name,
              file: {
                ...entry.file,
                tests: entry.file.tests.map((suiteCase) =>
                  suiteCase.title === "basic attribute"
                    ? { ...suiteCase, expect: [{ id: "regressed-now-fails" }] }
                    : suiteCase
                )
              }
            }
          : entry
      )
    };
    const report = runSuite(downgraded);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(132);
    expect(report.skippedDeclared).toBe(12);
    expect(exitCodeForReport(report)).toBe(1);
  });

  test("a manifest whose allowlist grows without shrinking shareableCases refuses to load", () => {
    expectLoadFailure((tmp) => {
      const manifestPath = join(tmp, "MANIFEST.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        declaredUnsupported: { file: string; title: string; reason: string }[];
      };
      manifest.declaredUnsupported.push({
        file: "basic.json",
        title: "basic attribute",
        reason: "downgraded without touching shareableCases"
      });
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }, "SUITE_MANIFEST_MISMATCH");
  });

  test("a case carrying no supported expectation kind refuses to load (no vacuous pass)", () => {
    expectLoadFailure((tmp) => {
      const target = join(tmp, "tests", "basic.json");
      const file = JSON.parse(readFileSync(target, "utf8")) as {
        tests: { title: string; view: unknown }[];
      };
      file.tests.push({
        title: "expectCount-only case (unmodeled expectation)",
        view: { resource: "Patient", select: [{ column: [{ name: "id", path: "id" }] }] },
        ...{ expectCount: 3 }
      });
      const bytes = JSON.stringify(file, null, 2);
      writeFileSync(target, bytes, "utf8");
      const manifestPath = join(tmp, "MANIFEST.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        totalCases: number;
        shareableCases: number;
        files: Record<string, { sha256: string; cases: number }>;
      };
      manifest.files["basic.json"] = {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        cases: file.tests.length
      };
      manifest.totalCases += 1;
      manifest.shareableCases += 1;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    }, "SUITE_FILE_INVALID");
  });

  test("an empty report never exits 0", () => {
    const empty: ConformanceReport = {
      total: 0,
      passed: 0,
      failed: 0,
      skippedDeclared: 0,
      failures: [],
      recountedCases: 0,
      manifestTotalCases: 0,
      manifestShareableCases: 0,
      official: {}
    };
    expect(exitCodeForReport(empty)).toBe(1);
  });
});
