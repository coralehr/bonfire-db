/**
 * Shared scaffolding for the BF-09 governance Stage-2 evals. The evals live on
 * the harness side and cannot import product code (the loop<->product firewall),
 * so they shell out to scripts/governance-demo/{govern,mcp-allowlist}.ts — real
 * @bonfire/core / @bonfire/mcp builds — and read the resulting rows with their
 * own postgres clients (owner for RLS-exempt ground truth, app for the
 * fail-closed RLS posture). All identities and clinical values are synthetic.
 */
import postgres from "postgres";
import type { Sql } from "postgres";
import { appUrl, fail, ownerUrl, runArtifact } from "./eval-util.js";

/** A governance actor as the store parses it (id + role + practiceId). */
export interface Actor {
  readonly id: string;
  readonly role: string;
  readonly practiceId: string;
}

/** One flattened step outcome as govern.ts prints it. */
export type StepOutcome =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message?: string } };

/** One propose/approve/commit step for the govern.ts driver. */
export interface Step {
  readonly op: "propose" | "approve" | "commit";
  readonly actor: unknown;
  readonly resource?: unknown;
  readonly proposalId?: string;
}

/** A syntactically valid scribe Patient the terminology path accepts. */
export function draftPatient(id: string): Record<string, unknown> {
  return {
    resourceType: "Patient",
    id,
    identifier: [{ system: "urn:bonfire:bf09-eval", value: id.slice(0, 8) }],
    name: [{ family: "Bf09Eval" }],
    gender: "female"
  };
}

/** Build an actor for a role in a practice (a plain object the store parses). */
export function actorFor(id: string, role: string, practiceId: string): Actor {
  return { id, role, practiceId };
}

/**
 * Drive a sequence of governance steps through the product path (one withTenant
 * transaction per step) and return the per-step outcomes, in order. A non-zero
 * exit or non-JSON tail is a loud eval failure (an unreadable job, never a
 * governance DENY — those are structured outcomes).
 */
export function govern(evalId: string, practiceId: string, steps: readonly Step[]): StepOutcome[] {
  const job = JSON.stringify({ practiceId, steps });
  const run = runArtifact(evalId, ["bun", "run", "scripts/governance-demo/govern.ts", job]);
  if (run.status !== 0) fail(evalId, `govern.ts exited ${String(run.status)}:\n${run.output}`);
  const last = run.output.trim().split("\n").filter((line) => line.length > 0).pop();
  if (last === undefined) fail(evalId, "govern.ts produced no output");
  let parsed: { results?: StepOutcome[] };
  try {
    parsed = JSON.parse(last) as { results?: StepOutcome[] };
  } catch (_cause) {
    return fail(evalId, `govern.ts output is not JSON:\n${run.output}`);
  }
  if (parsed.results === undefined) fail(evalId, `govern.ts output has no results:\n${run.output}`);
  return parsed.results;
}

/** The frozen MCP tool ALLOWLIST names, read across the firewall. */
export function mcpToolNames(evalId: string): string[] {
  const run = runArtifact(evalId, ["bun", "run", "scripts/governance-demo/mcp-allowlist.ts"]);
  if (run.status !== 0) fail(evalId, `mcp-allowlist.ts exited ${String(run.status)}:\n${run.output}`);
  const last = run.output.trim().split("\n").filter((line) => line.length > 0).pop();
  if (last === undefined) fail(evalId, "mcp-allowlist.ts produced no output");
  const parsed = JSON.parse(last) as { tools?: string[] };
  if (parsed.tools === undefined) fail(evalId, `mcp-allowlist.ts output has no tools:\n${run.output}`);
  return parsed.tools;
}

/** Assert an ok step and return its data, or fail loud. */
export function expectOk(evalId: string, outcome: StepOutcome, label: string): Record<string, unknown> {
  if (!outcome.ok) fail(evalId, `${label}: expected ok, got ${outcome.error.code} (${outcome.error.message ?? ""})`);
  return (outcome as { data: Record<string, unknown> }).data;
}

/** Assert a deny step carrying the expected code, or fail loud. */
export function expectErr(evalId: string, outcome: StepOutcome, code: string, label: string): void {
  if (outcome.ok) fail(evalId, `${label}: expected err ${code}, got ok`);
  if (outcome.error.code !== code) {
    fail(evalId, `${label}: expected err ${code}, got ${outcome.error.code}`);
  }
}

/** Owner + app clients for the ground-truth / RLS reads. Caller must end() both. */
export function clients(): { readonly owner: Sql; readonly app: Sql } {
  return {
    owner: postgres(ownerUrl(), { max: 1, onnotice: () => undefined }),
    app: postgres(appUrl(), { max: 1, onnotice: () => undefined })
  };
}
