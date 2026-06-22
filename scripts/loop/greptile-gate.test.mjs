import assert from "node:assert/strict";
import test from "node:test";

import {
  bodiesFrom,
  buildTriggerPayload,
  candidatesForShas,
  collectCandidates,
  evaluateGreptile,
  extractReviewedShas,
  extractScores,
  formatCheckRunDiagnostics,
  hasTriggerComment,
  isAwaitingGreptile,
  isHarnessTriggerBody,
  renderTriggerComment,
  resolveTriggerOptions,
  shasToInspect,
  triggerMarker,
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

test("isAwaitingGreptile covers missing and unscored review states", () => {
  assert.equal(isAwaitingGreptile({ status: "pending" }), true);
  assert.equal(isAwaitingGreptile({ status: "incomplete" }), true);
  assert.equal(isAwaitingGreptile({ status: "pass" }), false);
  assert.equal(isAwaitingGreptile({ status: "fail" }), false);
});

test("evaluateGreptile uses the latest scored candidate", () => {
  const outcome = evaluateGreptile([
    {
      createdAt: "2026-06-22T00:00:00Z",
      body: "Greptile score: 5/5",
      source: "review",
    },
    {
      createdAt: "2026-06-22T00:01:00Z",
      body: "Greptile review follow-up with no score",
      source: "comment",
    },
  ]);

  assert.equal(outcome.status, "pass");
  assert.equal(outcome.score, 5);
  assert.equal(outcome.source, "review");
});

test("evaluateGreptile fails on the newest scored candidate", () => {
  const outcome = evaluateGreptile([
    {
      createdAt: "2026-06-22T00:00:00Z",
      body: "Greptile score: 5/5",
      source: "old-review",
    },
    {
      createdAt: "2026-06-22T00:01:00Z",
      body: "Greptile score: 3/5",
      source: "new-review",
    },
  ]);

  assert.equal(outcome.status, "fail");
  assert.equal(outcome.score, 3);
  assert.equal(outcome.source, "new-review");
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

test("bodiesFrom ignores harness trigger comments", () => {
  const marker = triggerMarker({ headSha: "head-sha" });
  const bodies = bodiesFrom([
    {
      user: { login: "maintainer" },
      created_at: "2026-06-22T00:00:00Z",
      body: `@greptileai\n\n${marker}`,
      html_url: "comment",
    },
  ]);

  assert.equal(isHarnessTriggerBody(`@greptileai\n\n${marker}`), true);
  assert.deepEqual(bodies, []);
});

test("extractReviewedShas finds Greptile review footer commit links", () => {
  const shas = extractReviewedShas(
    'Last reviewed commit: ["message"](https://github.com/ticvision/bonfire-db/commit/6c9aabd75b565cdfab52f8d2b67ae40cab816302)',
  );

  assert.deepEqual(shas, ["6c9aabd75b565cdfab52f8d2b67ae40cab816302"]);
});

test("candidatesForShas drops stale scored reviews for older commits", () => {
  const candidates = [
    {
      body: "Confidence Score: 5/5",
      reviewedShas: ["old-sha"],
      source: "old",
    },
    {
      body: "Confidence Score: 4/5",
      reviewedShas: ["current-sha"],
      source: "current",
    },
    {
      body: "Confidence Score: 3/5",
      reviewedShas: [],
      source: "unscoped",
    },
  ];

  assert.deepEqual(
    candidatesForShas(candidates, ["current-sha"]).map((candidate) => candidate.source),
    ["current", "unscoped"],
  );
});

test("resolveTriggerOptions keeps URL and comment triggers independent", () => {
  assert.deepEqual(resolveTriggerOptions({
    triggerFlag: false,
    triggerUrl: "",
    explicitTriggerComment: "",
  }), {
    triggerRequested: false,
    triggerComment: "",
  });

  assert.deepEqual(resolveTriggerOptions({
    triggerFlag: true,
    triggerUrl: "",
    explicitTriggerComment: "",
  }), {
    triggerRequested: true,
    triggerComment: "@greptileai",
  });

  assert.deepEqual(resolveTriggerOptions({
    triggerFlag: true,
    triggerUrl: "https://example.test/trigger",
    explicitTriggerComment: "",
  }), {
    triggerRequested: true,
    triggerComment: "",
  });

  assert.deepEqual(resolveTriggerOptions({
    triggerFlag: false,
    triggerUrl: "https://example.test/trigger",
    explicitTriggerComment: "@greptileai review this draft",
  }), {
    triggerRequested: true,
    triggerComment: "@greptileai review this draft",
  });
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

test("buildTriggerPayload captures PR metadata for external review triggers", () => {
  const payload = buildTriggerPayload({
    repo: "ticvision/bonfire-db",
    pr: "1",
    pull: {
      html_url: "https://github.com/ticvision/bonfire-db/pull/1",
      head: {
        ref: "loop/BF-01",
        sha: "head-sha",
      },
    },
    shas: ["merge-sha", "head-sha"],
  });

  assert.deepEqual(payload, {
    action: "review",
    provider: "github",
    repository: "ticvision/bonfire-db",
    pullRequest: 1,
    pullRequestUrl: "https://github.com/ticvision/bonfire-db/pull/1",
    headRef: "loop/BF-01",
    headSha: "head-sha",
    mergeSha: "merge-sha",
    inspectedShas: ["merge-sha", "head-sha"],
  });
});

test("renderTriggerComment expands placeholders and appends an idempotency marker", () => {
  const payload = {
    repository: "ticvision/bonfire-db",
    pullRequest: 1,
    pullRequestUrl: "https://github.com/ticvision/bonfire-db/pull/1",
    headRef: "loop/BF-01",
    headSha: "head-sha",
  };
  const body = renderTriggerComment("review {repo}#{pr} at {sha}", payload);

  assert.match(body, /review ticvision\/bonfire-db#1 at head-sha/);
  assert.match(body, /bonfire-greptile-trigger:head-sha/);
});

test("hasTriggerComment detects an existing trigger marker", () => {
  const marker = triggerMarker({ headSha: "head-sha" });

  assert.equal(hasTriggerComment([{ body: `already posted ${marker}` }], marker), true);
  assert.equal(hasTriggerComment([{ body: "different comment" }], marker), false);
});
