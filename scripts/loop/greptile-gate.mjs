#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_TRIGGER_COMMENT = "@greptileai";

function readArg(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function readFlag(argv, name) {
  return argv.includes(`--${name}`);
}

function readIntOption({ argv, name, envName, fallback }) {
  const raw = readArg(argv, name) ?? process.env[envName];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function readExitCode({ argv, envName, fallback }) {
  const raw = readArg(argv, "pending-exit-code") ?? process.env[envName];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new Error("pending-exit-code must be an integer from 0 to 255");
  }
  return value;
}

function readBoolOption({ argv, name, envName, fallback }) {
  const raw = readArg(argv, name) ?? process.env[envName];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function checkRunText(item) {
  return [
    item.output?.title,
    item.output?.summary,
    item.output?.text,
  ].filter(Boolean).join("\n");
}

export function extractReviewedShas(body) {
  return [...String(body).matchAll(/\/commit\/([a-f0-9]{7,40})\b/gi)]
    .map((match) => match[1]);
}

export function isHarnessTriggerBody(body) {
  return String(body || "").includes("bonfire-greptile-trigger:");
}

export function bodiesFrom(items) {
  return items
    .filter((item) => {
      const login = item.user?.login || item.app?.slug || "";
      const name = item.name || "";
      const body = item.body || checkRunText(item);
      if (isHarnessTriggerBody(body)) return false;
      return /greptile/i.test(login) || /greptile/i.test(name) || /greptile/i.test(body);
    })
    .map((item) => {
      const body = item.body || checkRunText(item);
      return {
        createdAt: item.submitted_at || item.created_at || item.started_at || "",
        body,
        reviewedShas: extractReviewedShas(body),
        source: item.html_url || item.name || "greptile",
        status: item.status || "",
        conclusion: item.conclusion || "",
      };
    });
}

export function collectCandidates({ comments = [], reviews = [], checkRuns = [] }) {
  return [
    ...bodiesFrom(comments),
    ...bodiesFrom(reviews),
    ...bodiesFrom(checkRuns),
  ]
    .filter((item) => item.body)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function extractScores(body) {
  return [...String(body).matchAll(/(?:score|rating)?\s*:?\s*([0-5](?:\.0)?)\s*(?:\/|out of)\s*5/gi)]
    .map((match) => Number(match[1]));
}

export function evaluateGreptile(candidates) {
  if (candidates.length === 0) {
    return {
      status: "pending",
      message: "no Greptile review, comment, or check output found",
    };
  }

  const latest = candidates[candidates.length - 1];
  const scores = extractScores(latest.body);

  if (scores.length === 0) {
    return {
      status: "incomplete",
      message: "latest Greptile output did not contain a N/5 score",
      source: latest.source,
    };
  }

  const score = scores[scores.length - 1];
  if (score !== 5) {
    return {
      status: "fail",
      message: `Greptile score is ${score}/5, required 5/5`,
      source: latest.source,
      score,
    };
  }

  return {
    status: "pass",
    message: `PASS (${score}/5 from ${latest.source})`,
    source: latest.source,
    score,
  };
}

export function candidatesForShas(candidates, shas) {
  const acceptable = new Set(shas.filter(Boolean));
  return candidates.filter((candidate) => {
    if (!candidate.reviewedShas?.length) return true;
    return candidate.reviewedShas.some((sha) => acceptable.has(sha));
  });
}

export function resolveTriggerOptions({ triggerFlag, triggerUrl, explicitTriggerComment }) {
  const triggerRequested = triggerFlag || Boolean(triggerUrl) || Boolean(explicitTriggerComment);
  const triggerComment = explicitTriggerComment || (triggerFlag && !triggerUrl ? DEFAULT_TRIGGER_COMMENT : "");
  return { triggerRequested, triggerComment };
}

export function shasToInspect({ explicitSha, envSha, pull }) {
  return unique([explicitSha, envSha, pull?.head?.sha]);
}

export function formatCheckRunDiagnostics(checkRuns) {
  if (!checkRuns.length) return "no check runs visible to GitHub token";
  return checkRuns
    .map((run) => {
      const app = run.app?.slug || "unknown-app";
      const conclusion = run.conclusion || "no-conclusion";
      return `${run.name}: ${run.status}/${conclusion} (${app})`;
    })
    .join("\n");
}

export function buildTriggerPayload({ repo, pr, pull, shas }) {
  return {
    action: "review",
    provider: "github",
    repository: repo,
    pullRequest: Number(pr),
    pullRequestUrl: pull.html_url,
    headRef: pull.head?.ref,
    headSha: pull.head?.sha,
    mergeSha: shas.find((sha) => sha !== pull.head?.sha) || undefined,
    inspectedShas: shas,
  };
}

export function triggerMarker(payload) {
  return `<!-- bonfire-greptile-trigger:${payload.headSha || "unknown"} -->`;
}

export function renderTriggerComment(template, payload) {
  const replacements = {
    repo: payload.repository,
    pr: String(payload.pullRequest),
    pr_url: payload.pullRequestUrl,
    sha: payload.headSha || "",
    head_ref: payload.headRef || "",
  };
  const body = String(template).replace(/\{(repo|pr|pr_url|sha|head_ref)\}/g, (_match, key) => replacements[key]);
  return `${body}\n\n${triggerMarker(payload)}`;
}

export function hasTriggerComment(comments, marker) {
  return comments.some((comment) => String(comment.body || "").includes(marker));
}

function normalizePaginated(parsed) {
  if (Array.isArray(parsed) && parsed.every(Array.isArray)) return parsed.flat();
  if (Array.isArray(parsed) && parsed.length === 1) return parsed[0];
  return parsed;
}

function gh(path, options = {}) {
  const paginate = options.paginate ?? true;
  const args = ["api", path];
  if (paginate) args.push("--paginate", "--slurp");

  try {
    const parsed = JSON.parse(execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }));
    return paginate ? normalizePaginated(parsed) : parsed;
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : "";
    throw new Error(`gh api failed for ${path}${stderr ? `\n${stderr}` : ""}`);
  }
}

function ghPost(path, fields) {
  const args = ["api", path];
  for (const [key, value] of Object.entries(fields)) {
    args.push("-f", `${key}=${value}`);
  }

  try {
    const output = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return output ? JSON.parse(output) : {};
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : "";
    throw new Error(`gh api failed for ${path}${stderr ? `\n${stderr}` : ""}`);
  }
}

async function postTriggerUrl({ triggerUrl, triggerToken, payload }) {
  const headers = {
    "content-type": "application/json",
  };
  if (triggerToken) headers.authorization = `Bearer ${triggerToken}`;

  const response = await fetch(triggerUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`trigger URL returned HTTP ${response.status}${text ? `: ${text.slice(0, 500)}` : ""}`);
  }

  return `trigger URL accepted review request with HTTP ${response.status}`;
}

async function triggerGreptile({ repo, pr, snapshot, triggerUrl, triggerToken, triggerComment }) {
  const payload = buildTriggerPayload({
    repo,
    pr,
    pull: snapshot.pull,
    shas: snapshot.shas,
  });
  const messages = [];

  if (triggerUrl) {
    messages.push(await postTriggerUrl({ triggerUrl, triggerToken, payload }));
  }

  if (triggerComment) {
    const marker = triggerMarker(payload);
    if (hasTriggerComment(snapshot.comments, marker)) {
      messages.push("trigger comment already exists for this head SHA");
    } else {
      ghPost(`repos/${repo}/issues/${pr}/comments`, {
        body: renderTriggerComment(triggerComment, payload),
      });
      messages.push("posted Greptile trigger comment");
    }
  }

  if (messages.length === 0) {
    messages.push("trigger requested, but no GREPTILE_TRIGGER_URL or GREPTILE_TRIGGER_COMMENT is configured");
  }

  return messages;
}

function fetchSnapshot({ repo, pr, explicitSha }) {
  const comments = gh(`repos/${repo}/issues/${pr}/comments`);
  const reviews = gh(`repos/${repo}/pulls/${pr}/reviews`);
  const pull = gh(`repos/${repo}/pulls/${pr}`, { paginate: false });
  const shas = shasToInspect({
    explicitSha,
    envSha: process.env.GITHUB_SHA,
    pull,
  });

  const checkRuns = [];
  for (const sha of shas) {
    const payload = gh(`repos/${repo}/commits/${sha}/check-runs`, { paginate: false });
    checkRuns.push(...(payload.check_runs || []).map((run) => ({ ...run, inspectedSha: sha })));
  }

  return {
    candidates: candidatesForShas(collectCandidates({ comments, reviews, checkRuns }), shas),
    checkRuns,
    comments,
    draft: Boolean(pull.draft),
    pull,
    shas,
  };
}

function canRetry({ outcome, startedAt, waitSeconds }) {
  if (!["pending", "incomplete"].includes(outcome.status)) return false;
  if (waitSeconds <= 0) return false;
  return Date.now() - startedAt < waitSeconds * 1000;
}

function sleepMs({ startedAt, waitSeconds, pollSeconds }) {
  const elapsedMs = Date.now() - startedAt;
  const remainingMs = Math.max(0, waitSeconds * 1000 - elapsedMs);
  return Math.min(pollSeconds * 1000, remainingMs);
}

async function run() {
  const argv = process.argv.slice(2);
  const repo = readArg(argv, "repo") || process.env.GITHUB_REPOSITORY;
  const pr = readArg(argv, "pr") || process.env.PR_NUMBER || process.env.GITHUB_REF_NAME?.match(/^(\d+)\/merge$/)?.[1];
  const explicitSha = readArg(argv, "sha");
  const triggerUrl = readArg(argv, "trigger-url") || process.env.GREPTILE_TRIGGER_URL || "";
  const triggerToken = readArg(argv, "trigger-token") || process.env.GREPTILE_TRIGGER_TOKEN || "";
  const explicitTriggerComment = readArg(argv, "trigger-comment") || process.env.GREPTILE_TRIGGER_COMMENT || "";
  const { triggerRequested, triggerComment } = resolveTriggerOptions({
    triggerFlag: readFlag(argv, "trigger"),
    triggerUrl,
    explicitTriggerComment,
  });
  const triggerRequired = readBoolOption({
    argv,
    name: "trigger-required",
    envName: "GREPTILE_TRIGGER_REQUIRED",
    fallback: false,
  });
  const waitSeconds = readIntOption({
    argv,
    name: "wait-seconds",
    envName: "GREPTILE_WAIT_SECONDS",
    fallback: 0,
  });
  const pollSeconds = readIntOption({
    argv,
    name: "poll-seconds",
    envName: "GREPTILE_POLL_SECONDS",
    fallback: DEFAULT_POLL_SECONDS,
  });
  const pendingExitCode = readExitCode({
    argv,
    envName: "GREPTILE_PENDING_EXIT_CODE",
    fallback: 1,
  });

  if (!repo || !pr) {
    console.error("greptile-gate: missing repo or PR number");
    return 1;
  }

  if (waitSeconds > 0 && pollSeconds === 0) {
    console.error("greptile-gate: poll-seconds must be greater than zero when wait-seconds is set");
    return 1;
  }

  const startedAt = Date.now();
  let attempt = 0;
  let lastSnapshot = { checkRuns: [], comments: [], draft: false, pull: {}, shas: [] };
  let lastOutcome;
  let triggerAttempted = false;

  while (true) {
    attempt += 1;
    try {
      lastSnapshot = fetchSnapshot({ repo, pr, explicitSha });
      lastOutcome = evaluateGreptile(lastSnapshot.candidates);
    } catch (error) {
      console.error(`greptile-gate: ${error.message}`);
      return 1;
    }

    if (lastOutcome.status === "pass") {
      console.log(`greptile-gate: ${lastOutcome.message}`);
      return 0;
    }

    if (lastOutcome.status === "fail") {
      console.error(`greptile-gate: ${lastOutcome.message}`);
      console.error(`greptile-gate: source ${lastOutcome.source}`);
      return 1;
    }

    if (lastSnapshot.draft && lastOutcome.status === "pending") {
      console.error("greptile-gate: PR is draft; Greptile may not publish review output until ready_for_review");
      break;
    }

    if (triggerRequested && !triggerAttempted && ["pending", "incomplete"].includes(lastOutcome.status)) {
      triggerAttempted = true;
      try {
        const messages = await triggerGreptile({
          repo,
          pr,
          snapshot: lastSnapshot,
          triggerUrl,
          triggerToken,
          triggerComment,
        });
        for (const message of messages) {
          console.log(`greptile-gate: ${message}`);
        }
      } catch (error) {
        console.error(`greptile-gate: trigger failed: ${error.message}`);
        if (triggerRequired) return 1;
      }
    }

    if (!canRetry({ outcome: lastOutcome, startedAt, waitSeconds })) break;

    const waitMs = sleepMs({ startedAt, waitSeconds, pollSeconds });
    const shas = lastSnapshot.shas.length ? lastSnapshot.shas.join(", ") : "none";
    console.log(`greptile-gate: ${lastOutcome.message}; waiting ${Math.ceil(waitMs / 1000)}s (attempt ${attempt}, shas: ${shas})`);
    await delay(waitMs);
  }

  console.error(`greptile-gate: ${lastOutcome.message}`);
  if (lastOutcome.source) console.error(`greptile-gate: source ${lastOutcome.source}`);
  if (lastOutcome.status === "pending") {
    if (lastSnapshot.draft) {
      console.error("greptile-gate: draft PR detected; mark the PR ready for review to require Greptile 5/5");
    }
    console.error(`greptile-gate: inspected shas ${lastSnapshot.shas.join(", ") || "none"}`);
    console.error("greptile-gate: visible check runs:");
    console.error(formatCheckRunDiagnostics(lastSnapshot.checkRuns));
    return pendingExitCode;
  }

  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then((code) => {
    process.exit(code);
  });
}
