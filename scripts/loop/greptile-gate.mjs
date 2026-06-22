#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_POLL_SECONDS = 30;

function readArg(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  return argv[index + 1];
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

export function bodiesFrom(items) {
  return items
    .filter((item) => {
      const login = item.user?.login || item.app?.slug || "";
      const name = item.name || "";
      const body = item.body || checkRunText(item);
      return /greptile/i.test(login) || /greptile/i.test(name) || /greptile/i.test(body);
    })
    .map((item) => ({
      createdAt: item.submitted_at || item.created_at || item.started_at || "",
      body: item.body || checkRunText(item),
      source: item.html_url || item.name || "greptile",
      status: item.status || "",
      conclusion: item.conclusion || "",
    }));
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
    candidates: collectCandidates({ comments, reviews, checkRuns }),
    checkRuns,
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
  let lastSnapshot = { checkRuns: [], shas: [] };
  let lastOutcome;

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

    if (!canRetry({ outcome: lastOutcome, startedAt, waitSeconds })) break;

    const waitMs = sleepMs({ startedAt, waitSeconds, pollSeconds });
    const shas = lastSnapshot.shas.length ? lastSnapshot.shas.join(", ") : "none";
    console.log(`greptile-gate: ${lastOutcome.message}; waiting ${Math.ceil(waitMs / 1000)}s (attempt ${attempt}, shas: ${shas})`);
    await delay(waitMs);
  }

  console.error(`greptile-gate: ${lastOutcome.message}`);
  if (lastOutcome.source) console.error(`greptile-gate: source ${lastOutcome.source}`);
  if (lastOutcome.status === "pending") {
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
