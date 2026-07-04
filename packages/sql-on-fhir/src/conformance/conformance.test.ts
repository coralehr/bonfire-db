/**
 * Negative controls for the conformance pipeline (fake-conformance danger
 * check): a tampered suite refuses to load, a wrong expectation flips the run
 * red, skip honesty is structural, and the pass counts match an independent
 * recount of the vendored suite files.
 */
import { describe, expect, test } from "bun:test";
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

describe("conformance run (real vendored suite)", () => {
  test("passes every shareable case and declares the rest", () => {
    const report = runReal();
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(report.manifestTotalCases - report.skippedDeclared);
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
    const tmp = mkdtempSync(join(tmpdir(), "bf04-suite-tamper-"));
    try {
      cpSync(SUITE_DIR, tmp, { recursive: true });
      const target = join(tmp, "tests", "basic.json");
      const original = readFileSync(target, "utf8");
      writeFileSync(target, original.replace('"pt1"', '"pt9"'), "utf8");
      const result = loadSuite(tmp);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("SUITE_FILE_TAMPERED");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("a missing suite file fails closed as a manifest mismatch", () => {
    const tmp = mkdtempSync(join(tmpdir(), "bf04-suite-missing-"));
    try {
      cpSync(SUITE_DIR, tmp, { recursive: true });
      rmSync(join(tmp, "tests", "basic.json"));
      const result = loadSuite(tmp);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("SUITE_MANIFEST_MISMATCH");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
