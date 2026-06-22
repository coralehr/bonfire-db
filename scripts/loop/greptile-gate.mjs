#!/usr/bin/env node
import { execFileSync } from "node:child_process";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const repo = arg("repo") || process.env.GITHUB_REPOSITORY;
const pr = arg("pr") || process.env.PR_NUMBER || process.env.GITHUB_REF_NAME?.match(/^(\d+)\/merge$/)?.[1];
const sha = arg("sha") || process.env.GITHUB_SHA;

if (!repo || !pr) {
  console.error("greptile-gate: missing repo or PR number");
  process.exit(1);
}

function gh(path) {
  try {
    return JSON.parse(execFileSync("gh", ["api", path, "--paginate"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch (error) {
    console.error(`greptile-gate: gh api failed for ${path}`);
    if (error.stderr) console.error(String(error.stderr));
    process.exit(1);
  }
}

function bodiesFrom(items) {
  return items
    .filter((item) => {
      const login = item.user?.login || item.app?.slug || "";
      const body = item.body || item.output?.summary || item.output?.text || "";
      return /greptile/i.test(login) || /greptile/i.test(body);
    })
    .map((item) => ({
      createdAt: item.submitted_at || item.created_at || item.started_at || "",
      body: item.body || item.output?.summary || item.output?.text || "",
      source: item.html_url || item.name || "greptile",
    }));
}

const comments = bodiesFrom(gh(`repos/${repo}/issues/${pr}/comments`));
const reviews = bodiesFrom(gh(`repos/${repo}/pulls/${pr}/reviews`));
let checkRuns = [];

if (sha) {
  const checkPayload = gh(`repos/${repo}/commits/${sha}/check-runs`);
  checkRuns = bodiesFrom(checkPayload.check_runs || []);
}

const candidates = [...comments, ...reviews, ...checkRuns]
  .filter((item) => item.body)
  .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

if (candidates.length === 0) {
  console.error("greptile-gate: no Greptile review, comment, or check output found");
  process.exit(1);
}

const latest = candidates[candidates.length - 1];
const scores = [...latest.body.matchAll(/(?:score|rating)?\s*:?\s*([0-5])\s*\/\s*5/gi)]
  .map((match) => Number(match[1]));

if (scores.length === 0) {
  console.error("greptile-gate: latest Greptile output did not contain a N/5 score");
  console.error(`greptile-gate: source ${latest.source}`);
  process.exit(1);
}

const score = scores[scores.length - 1];
if (score !== 5) {
  console.error(`greptile-gate: Greptile score is ${score}/5, required 5/5`);
  console.error(`greptile-gate: source ${latest.source}`);
  process.exit(1);
}

console.log(`greptile-gate: PASS (${score}/5 from ${latest.source})`);
