/**
 * The gate manifest — the single list of deterministic gates, mirroring CI.
 *
 * Stage 0 (fast hooks): format · typecheck · lint. Stage 1 (full deterministic):
 * secret-scan · structural · boundaries · suppressions · lockfile · semgrep ·
 * knip · jscpd · test. Tools that ship as devDependencies always run; externally
 * installed tools (semgrep, gitleaks) probe for availability and SKIP when absent
 * — visible, and a failure only under `--strict` (CI), never a silent pass.
 *
 * The allowed-paths gate is not here: it needs a slice id, so the CLI appends it
 * (./allowed-paths-gate.ts) only when `--slice` is given.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { commandDetail, failureReason } from "./exec.js";
import { commandGate, type Gate } from "./gate.js";
import { LOCKFILE_GATE } from "./lockfile-gate.js";

const BOUNDARY_DIRS = ["loop", "packages", "apps", "drizzle", "seed", "scripts"] as const;
const SUPPRESSION_DIRS = ["loop", "packages", "apps"] as const;
// Assembled at runtime so this gate's own source never trips the grep it runs.
const SUPPRESSION_MARKER = ["no", "semgrep"].join("");

function existingDirs(repoRoot: string, dirs: readonly string[]): string[] {
  return dirs.filter((dir) => existsSync(join(repoRoot, dir)));
}

/** A gate whose tool is installed separately (container/binary); skips if absent. */
function externalToolGate(spec: {
  name: string;
  tier: Gate["tier"];
  probe: readonly string[];
  commands: readonly (readonly string[])[];
  hint: string;
}): Gate {
  return {
    name: spec.name,
    stage: 1,
    tier: spec.tier,
    run: (ctx) => {
      if (!ctx.exec(spec.probe).ok) {
        return { status: "skip", summary: `${spec.name} skipped — ${spec.hint}`, detail: "" };
      }
      for (const argv of spec.commands) {
        const r = ctx.exec(argv);
        if (!r.ok) {
          return {
            status: "fail",
            summary: `${spec.name} failed — ${failureReason(r)}`,
            detail: commandDetail(r, "(no output)")
          };
        }
      }
      return { status: "pass", summary: `${spec.name} passed`, detail: "" };
    }
  };
}

const BOUNDARIES_GATE: Gate = {
  name: "boundaries",
  stage: 1,
  tier: "blocking",
  run: (ctx) => {
    const dirs = existingDirs(ctx.repoRoot, BOUNDARY_DIRS);
    if (dirs.length === 0)
      return { status: "pass", summary: "boundaries passed — no source dirs", detail: "" };
    const r = ctx.exec(["bunx", "depcruise", ...dirs, "--config", ".dependency-cruiser.cjs"]);
    if (r.ok) return { status: "pass", summary: "boundaries passed", detail: "" };
    return {
      status: "fail",
      summary: `boundaries failed — ${failureReason(r)}`,
      detail: commandDetail(r, "(no output)")
    };
  }
};

const SUPPRESSIONS_GATE: Gate = {
  name: "suppressions",
  stage: 1,
  tier: "blocking",
  run: (ctx) => {
    const dirs = existingDirs(ctx.repoRoot, SUPPRESSION_DIRS);
    if (dirs.length === 0)
      return { status: "pass", summary: "suppressions passed — no source dirs", detail: "" };
    const r = ctx.exec([
      "grep",
      "-rn",
      SUPPRESSION_MARKER,
      "--include=*.ts",
      "--include=*.tsx",
      "--include=*.mts",
      "--include=*.cts",
      ...dirs
    ]);
    // grep: exit 1 = no match (PASS), 0 = match found (FAIL), >=2 = grep error (FAIL closed).
    if (r.spawnError)
      return {
        status: "fail",
        summary: `suppressions failed — could not run (${r.spawnError})`,
        detail: r.spawnError
      };
    if (r.exitCode === 1)
      return {
        status: "pass",
        summary: `suppressions passed — no inline // ${SUPPRESSION_MARKER}`,
        detail: ""
      };
    if (r.exitCode === 0)
      return {
        status: "fail",
        summary: `suppressions failed — inline // ${SUPPRESSION_MARKER} found`,
        detail: r.output
      };
    return {
      status: "fail",
      summary: `suppressions failed — grep error (exit ${String(r.exitCode)})`,
      detail: r.output
    };
  }
};

/** The full deterministic gate set, in fail-fast display order within each stage. */
export const STANDARD_GATES: readonly Gate[] = [
  // Stage 0 — fast hooks (format/typecheck/lint), the majority of agent mistakes.
  commandGate({
    name: "format",
    stage: 0,
    tier: "blocking",
    commands: [["bunx", "biome", "ci", "."]]
  }),
  commandGate({ name: "typecheck", stage: 0, tier: "blocking", commands: [["bunx", "tsc", "-b"]] }),
  commandGate({ name: "lint", stage: 0, tier: "blocking", commands: [["bunx", "eslint", "."]] }),

  // Stage 1 — full deterministic stack. Secret scan first (cheap + catastrophic).
  externalToolGate({
    name: "secret-scan",
    tier: "blocking",
    probe: ["gitleaks", "version"],
    commands: [
      [
        "gitleaks",
        "dir",
        ".",
        "--config",
        ".gitleaks.toml",
        "--redact",
        "--no-banner",
        "--exit-code",
        "1"
      ],
      [
        "gitleaks",
        "git",
        ".",
        "--config",
        ".gitleaks.toml",
        "--redact",
        "--no-banner",
        "--exit-code",
        "1"
      ]
    ],
    hint: "gitleaks not installed (enforced in CI)"
  }),
  commandGate({
    name: "structural",
    stage: 1,
    tier: "blocking",
    commands: [
      ["bunx", "ast-grep", "test", "--skip-snapshot-tests"],
      ["bunx", "ast-grep", "scan"]
    ]
  }),
  BOUNDARIES_GATE,
  SUPPRESSIONS_GATE,
  LOCKFILE_GATE,
  externalToolGate({
    name: "semgrep",
    tier: "blocking",
    probe: ["semgrep", "--version"],
    commands: [
      [
        "semgrep",
        "scan",
        "--config",
        "semgrep.yml",
        "--error",
        "--strict",
        "--metrics",
        "off",
        "--exclude",
        "node_modules",
        "--exclude",
        "dist",
        "--exclude",
        "build",
        "--exclude",
        ".turbo",
        "--exclude",
        "coverage"
      ],
      // Rule behaviour corpus (ratchet BP-011): annotated fixtures prove each
      // rule fires on known-bad code and stays silent on sanctioned idioms —
      // a rule edit that breaks either side fails the gate.
      ["semgrep", "scan", "--test", "sgrule-tests/semgrep"]
    ],
    hint: "semgrep not installed (enforced in CI container)"
  }),
  // The synthetic-only tripwire as a PERMANENT gate, not a one-shot slice
  // check: the scanner self-tests every detector class on each run (exit 2 if
  // any fails to fire) before sweeping the committed fixture corpus.
  commandGate({
    name: "synthetic-only",
    stage: 1,
    tier: "blocking",
    commands: [["bun", "run", "scan:synthetic"]]
  }),
  // knip + jscpd graduated advisory -> blocking at the post-BF-02 checkpoint
  // (P2b): both ran green through BF-01/BF-02 and the codebase shape has
  // stabilized enough that dead code / duplication is now a landing failure,
  // not a hint. A silent downgrade back to advisory fails gates.test.ts.
  commandGate({ name: "knip", stage: 1, tier: "blocking", commands: [["bunx", "knip"]] }),
  commandGate({
    name: "jscpd",
    stage: 1,
    tier: "blocking",
    commands: [
      [
        "bunx",
        "jscpd",
        ".",
        "--ignore",
        "**/node_modules/**,**/dist/**,**/build/**,**/.turbo/**,**/coverage/**"
      ]
    ]
  }),
  commandGate({
    name: "test",
    stage: 1,
    tier: "blocking",
    commands: [["bunx", "turbo", "run", "test"]]
  })
];
