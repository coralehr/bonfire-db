import assert from "node:assert/strict";
import test from "node:test";

import {
  actionRunFromLink,
  evaluateChecks,
  extractFailureSnippets,
  formatCheck,
  isNoChecksError,
  isPendingLogError,
  normalizeCheckBucket,
} from "./ci-watch.mjs";

test("actionRunFromLink extracts run and job ids from GitHub Actions URLs", () => {
  assert.deepEqual(actionRunFromLink("https://github.com/org/repo/actions/runs/123/job/456"), {
    runId: "123",
    jobId: "456",
  });

  assert.deepEqual(actionRunFromLink("https://github.com/org/repo/pull/1"), {
    runId: "",
    jobId: "",
  });
});

test("normalizeCheckBucket maps gh check states", () => {
  assert.equal(normalizeCheckBucket({ bucket: "pass", state: "SUCCESS" }), "pass");
  assert.equal(normalizeCheckBucket({ state: "FAILURE" }), "fail");
  assert.equal(normalizeCheckBucket({ state: "IN_PROGRESS" }), "pending");
  assert.equal(normalizeCheckBucket({ bucket: "skipping" }), "pass");
});

test("evaluateChecks fails before pending and passes only when all visible checks pass", () => {
  assert.equal(evaluateChecks([]).status, "pending");
  assert.equal(evaluateChecks([{ name: "build", bucket: "pass" }]).status, "pass");
  assert.equal(evaluateChecks([{ name: "build", bucket: "pending" }]).status, "pending");

  const failed = evaluateChecks([
    { name: "build", bucket: "pending" },
    { name: "test", bucket: "fail" },
  ]);

  assert.equal(failed.status, "fail");
  assert.equal(failed.failing[0].name, "test");
});

test("extractFailureSnippets keeps relevant failure context without full logs", () => {
  const snippets = extractFailureSnippets([
    "setup",
    "running checks",
    "verify: typecheck",
    "src/index.ts:1: error TS2322",
    "Process completed with exit code 1.",
    "cleanup",
  ].join("\n"));

  assert.deepEqual(snippets, [
    "setup",
    "running checks",
    "verify: typecheck",
    "src/index.ts:1: error TS2322",
    "Process completed with exit code 1.",
    "cleanup",
  ]);
});

test("extractFailureSnippets trims Greptile polling noise", () => {
  const snippets = extractFailureSnippets([
    "greptile-gate: no Greptile review, comment, or check output found; waiting 30s",
    "greptile-gate: no Greptile review, comment, or check output found; waiting 30s",
    "greptile-gate: Greptile score is 3/5, required 5/5",
    "greptile-gate: source https://github.com/example/repo/pull/1#issuecomment-1",
    "##[error]Process completed with exit code 1.",
  ].join("\n"), { context: 0 });

  assert.deepEqual(snippets, [
    "greptile-gate: Greptile score is 3/5, required 5/5",
    "greptile-gate: source https://github.com/example/repo/pull/1#issuecomment-1",
    "##[error]Process completed with exit code 1.",
  ]);
});

test("formatCheck includes workflow, state, and link", () => {
  assert.equal(
    formatCheck({
      workflow: "Loop CI",
      name: "Bonfire verify",
      state: "SUCCESS",
      link: "https://example.test/job",
    }),
    "Loop CI / Bonfire verify: SUCCESS (https://example.test/job)",
  );
});

test("isPendingLogError detects GitHub Actions log availability races", () => {
  assert.equal(
    isPendingLogError(new Error("run 123 is still in progress; logs will be available when it is complete")),
    true,
  );
  assert.equal(isPendingLogError(new Error("HTTP 404")), false);
});

test("isNoChecksError detects GitHub checks creation races", () => {
  assert.equal(isNoChecksError(new Error("no checks reported on the 'loop/BF-01' branch")), true);
  assert.equal(isNoChecksError(new Error("HTTP 500")), false);
});
