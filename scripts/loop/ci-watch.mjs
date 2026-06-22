#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_POLL_SECONDS = 30;
const FAILURE_LINE_LIMIT = 80;

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

function stripAnsi(value) {
  return String(value).replace(/\u001b\[[0-9;]*m/g, "");
}

export function actionRunFromLink(link) {
  const match = String(link || "").match(/\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/);
  return {
    runId: match?.[1] || "",
    jobId: match?.[2] || "",
  };
}

export function normalizeCheckBucket(check) {
  const bucket = String(check.bucket || "").toLowerCase();
  if (["pass", "fail", "pending"].includes(bucket)) return bucket;
  if (["skip", "skipping"].includes(bucket)) return "pass";

  const state = String(check.state || "").toUpperCase();
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(state)) return "pass";
  if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(state)) return "fail";
  if (["EXPECTED", "PENDING", "QUEUED", "REQUESTED", "WAITING", "IN_PROGRESS"].includes(state)) return "pending";
  return "pending";
}

export function evaluateChecks(checks) {
  if (!checks.length) {
    return {
      status: "pending",
      failing: [],
      pending: [],
      passing: [],
      message: "no PR checks are visible yet",
    };
  }

  const groups = {
    failing: [],
    pending: [],
    passing: [],
  };

  for (const check of checks) {
    const bucket = normalizeCheckBucket(check);
    if (bucket === "fail") groups.failing.push(check);
    if (bucket === "pending") groups.pending.push(check);
    if (bucket === "pass") groups.passing.push(check);
  }

  if (groups.failing.length > 0) {
    return {
      status: "fail",
      ...groups,
      message: `${groups.failing.length} check(s) failed`,
    };
  }

  if (groups.pending.length > 0) {
    return {
      status: "pending",
      ...groups,
      message: `${groups.pending.length} check(s) still pending`,
    };
  }

  return {
    status: "pass",
    ...groups,
    message: `${groups.passing.length} check(s) passed`,
  };
}

export function formatCheck(check) {
  const workflow = check.workflow ? `${check.workflow} / ` : "";
  const state = check.state || check.bucket || "unknown";
  return `${workflow}${check.name}: ${state}${check.link ? ` (${check.link})` : ""}`;
}

function lineLooksRelevant(line) {
  if (/greptile-gate:/i.test(line)) {
    return /score|source|fail|error|required|draft|inspected|visible check runs/i.test(line);
  }

  return /##\[error\]|(^|\s)(error|failed|failure|exit code|exception|traceback|timed out|denied|not found|cannot|could not|verify:)/i.test(line);
}

export function extractFailureSnippets(log, { context = 2, limit = FAILURE_LINE_LIMIT } = {}) {
  const lines = stripAnsi(log).split(/\r?\n/);
  const selected = new Set();

  lines.forEach((line, index) => {
    if (!lineLooksRelevant(line)) return;
    for (let offset = -context; offset <= context; offset += 1) {
      const selectedIndex = index + offset;
      if (selectedIndex >= 0 && selectedIndex < lines.length) selected.add(selectedIndex);
    }
  });

  if (selected.size === 0) {
    return lines.slice(Math.max(0, lines.length - limit)).filter(Boolean);
  }

  return [...selected]
    .sort((a, b) => a - b)
    .map((index) => lines[index])
    .filter(Boolean)
    .slice(0, limit);
}

function ghJson(args) {
  try {
    return JSON.parse(execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }));
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : "";
    throw new Error(`gh ${args.join(" ")} failed${stderr ? `\n${stderr}` : ""}`);
  }
}

function ghText(args) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : "";
    throw new Error(`gh ${args.join(" ")} failed${stderr ? `\n${stderr}` : ""}`);
  }
}

export function isPendingLogError(error) {
  return /still in progress|logs will be available/i.test(String(error?.message || error));
}

export function isNoChecksError(error) {
  return /no checks reported/i.test(String(error?.message || error));
}

function fetchChecks({ repo, pr }) {
  try {
    return ghJson([
      "pr",
      "checks",
      String(pr),
      "--repo",
      repo,
      "--json",
      "name,state,bucket,link,workflow",
    ]);
  } catch (error) {
    if (isNoChecksError(error)) return [];
    throw error;
  }
}

function fetchActionLog({ repo, link }) {
  const { runId, jobId } = actionRunFromLink(link);
  if (!runId) return "";

  const args = ["run", "view", runId, "--repo", repo];
  if (jobId) args.push("--job", jobId);
  args.push("--log");
  return ghText(args);
}

function printChecks(checks) {
  for (const check of checks) {
    console.log(`ci-watch: ${formatCheck(check)}`);
  }
}

async function run() {
  const argv = process.argv.slice(2);
  const repo = readArg(argv, "repo") || process.env.GITHUB_REPOSITORY;
  const pr = readArg(argv, "pr") || process.env.PR_NUMBER || process.env.GITHUB_REF_NAME?.match(/^(\d+)\/merge$/)?.[1];
  const waitSeconds = readIntOption({
    argv,
    name: "wait-seconds",
    envName: "CI_WATCH_WAIT_SECONDS",
    fallback: 0,
  });
  const pollSeconds = readIntOption({
    argv,
    name: "poll-seconds",
    envName: "CI_WATCH_POLL_SECONDS",
    fallback: DEFAULT_POLL_SECONDS,
  });
  const pendingExitCode = readIntOption({
    argv,
    name: "pending-exit-code",
    envName: "CI_WATCH_PENDING_EXIT_CODE",
    fallback: 1,
  });

  if (!repo || !pr) {
    console.error("ci-watch: missing repo or PR number");
    return 1;
  }

  if (waitSeconds > 0 && pollSeconds === 0) {
    console.error("ci-watch: poll-seconds must be greater than zero when wait-seconds is set");
    return 1;
  }

  const startedAt = Date.now();
  let attempt = 0;

  while (true) {
    attempt += 1;

    let checks;
    try {
      checks = fetchChecks({ repo, pr });
    } catch (error) {
      console.error(`ci-watch: ${error.message}`);
      return 1;
    }

    const outcome = evaluateChecks(checks);

    if (outcome.status === "pass") {
      console.log(`ci-watch: PASS - ${outcome.message}`);
      printChecks(checks);
      return 0;
    }

    if (outcome.status === "fail") {
      console.error(`ci-watch: FAIL - ${outcome.message}`);
      printChecks(checks);
      const pendingLogs = [];

      for (const check of outcome.failing) {
        console.error(`ci-watch: failure ${formatCheck(check)}`);
        const { runId } = actionRunFromLink(check.link);
        if (!runId) continue;

        try {
          const log = fetchActionLog({ repo, link: check.link });
          const snippets = extractFailureSnippets(log);
          if (snippets.length > 0) {
            console.error(`ci-watch: relevant log lines for ${check.name}:`);
            for (const line of snippets) console.error(line);
          }
        } catch (error) {
          if (isPendingLogError(error)) {
            pendingLogs.push(check);
            console.error(`ci-watch: log for ${check.name} is not available yet`);
            continue;
          }
          console.error(`ci-watch: could not fetch log for ${check.name}: ${error.message}`);
        }
      }

      const elapsedMs = Date.now() - startedAt;
      if (pendingLogs.length > 0 && waitSeconds > 0 && elapsedMs < waitSeconds * 1000) {
        const remainingMs = Math.max(0, waitSeconds * 1000 - elapsedMs);
        const waitMs = Math.min(pollSeconds * 1000, remainingMs);
        console.log(`ci-watch: waiting ${Math.ceil(waitMs / 1000)}s for failed job logs (attempt ${attempt})`);
        await delay(waitMs);
        continue;
      }

      return 1;
    }

    const elapsedMs = Date.now() - startedAt;
    if (waitSeconds <= 0 || elapsedMs >= waitSeconds * 1000) {
      console.error(`ci-watch: PENDING - ${outcome.message}`);
      printChecks(checks);
      return pendingExitCode;
    }

    const remainingMs = Math.max(0, waitSeconds * 1000 - elapsedMs);
    const waitMs = Math.min(pollSeconds * 1000, remainingMs);
    console.log(`ci-watch: ${outcome.message}; waiting ${Math.ceil(waitMs / 1000)}s (attempt ${attempt})`);
    await delay(waitMs);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().then((code) => {
    process.exit(code);
  });
}
