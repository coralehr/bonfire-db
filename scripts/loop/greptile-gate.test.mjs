import assert from "node:assert/strict";
import test from "node:test";

import {
  bodiesFrom,
  collectCandidates,
  evaluateGreptile,
  extractScores,
  formatCheckRunDiagnostics,
  shasToInspect,
} from "./greptile-gate.mjs";

test("extractScores accepts common Greptile score formats", () => {
  assert.deepEqual(extractScores("Score: 5/5"), [5]);
  assert.deepEqual(extractScores("rating 4 out of 5"), [4]);
  assert.deepEqual(extractScores("final score: 5.0 / 5"), [5]);
});

test("evaluateGreptile passes on the latest 5/5 candidate", () => {
  const outcome = evaluateGreptile([
    {
      createdAt: "2026-06-22T00:00:00Z",
      body: "Greptile score: 5/5",
      source: "review",
    },
  ]);

  assert.equal(outcome.status, "pass");
  assert.equal(outcome.score, 5);
});

test("evaluateGreptile fails on a visible sub-5 score", () => {
  const outcome = evaluateGreptile([
    {
      createdAt: "2026-06-22T00:00:00Z",
      body: "Greptile score: 4/5",
      source: "review",
    },
  ]);

  assert.equal(outcome.status, "fail");
  assert.equal(outcome.score, 4);
});

test("evaluateGreptile treats missing Greptile output as pending", () => {
  const outcome = evaluateGreptile([]);

  assert.equal(outcome.status, "pending");
});

test("evaluateGreptile treats Greptile output without a score as incomplete", () => {
  const outcome = evaluateGreptile([
    {
      createdAt: "2026-06-22T00:00:00Z",
      body: "Greptile review is queued",
      source: "check",
    },
  ]);

  assert.equal(outcome.status, "incomplete");
});

test("bodiesFrom includes Greptile check run output title, summary, and text", () => {
  const bodies = bodiesFrom([
    {
      name: "Greptile",
      html_url: "https://example.test/check",
      started_at: "2026-06-22T00:00:00Z",
      app: { slug: "greptile" },
      output: {
        title: "Review complete",
        summary: "Score: 5/5",
        text: "No blocking issues.",
      },
    },
  ]);

  assert.equal(bodies.length, 1);
  assert.match(bodies[0].body, /Review complete/);
  assert.match(bodies[0].body, /Score: 5\/5/);
  assert.match(bodies[0].body, /No blocking issues/);
});

test("collectCandidates sorts comments, reviews, and check runs chronologically", () => {
  const candidates = collectCandidates({
    comments: [{
      user: { login: "greptile-ai" },
      created_at: "2026-06-22T02:00:00Z",
      body: "Score: 5/5",
      html_url: "comment",
    }],
    reviews: [{
      user: { login: "greptile-ai" },
      submitted_at: "2026-06-22T01:00:00Z",
      body: "Score: 4/5",
      html_url: "review",
    }],
  });

  assert.deepEqual(candidates.map((candidate) => candidate.source), ["review", "comment"]);
});

test("shasToInspect checks both workflow event SHA and PR head SHA", () => {
  const shas = shasToInspect({
    explicitSha: undefined,
    envSha: "merge-sha",
    pull: { head: { sha: "head-sha" } },
  });

  assert.deepEqual(shas, ["merge-sha", "head-sha"]);
});

test("formatCheckRunDiagnostics lists visible check names and app slugs", () => {
  const diagnostics = formatCheckRunDiagnostics([
    {
      name: "Harness syntax",
      status: "completed",
      conclusion: "success",
      app: { slug: "github-actions" },
    },
  ]);

  assert.equal(diagnostics, "Harness syntax: completed/success (github-actions)");
});
