/**
 * Shared scaffolding for the BF-06 Stage-2 evals. Drives the PRODUCT search path
 * through scripts/search-demo/run.ts (the evals are on the harness side of the
 * harness<->product firewall and cannot import @bonfire/core), then asserts on
 * the returned outcome. Synthetic-only corpora, minted per eval run.
 */
import { fail, lastJsonLine, runArtifact } from "./eval-util.js";

const SYNTH_SYSTEM = "http://example.org/synthetic";

export interface Doc {
  readonly id: string;
  readonly type: string;
  readonly content: Record<string, unknown>;
}

/** A synthetic Observation with an exact code token and an optional free-text note. */
export function observation(code: string, note?: string): Doc {
  const id = crypto.randomUUID();
  const content: Record<string, unknown> = {
    resourceType: "Observation",
    id,
    status: "final",
    code: { coding: [{ system: SYNTH_SYSTEM, code }] }
  };
  if (note !== undefined) content.note = [{ text: note }];
  return { id, type: "Observation", content };
}

/** A clinician/TREAT request (the only v0 allow shape). */
export function clinicianInput(query: string, practice: string): unknown {
  return {
    query,
    subject: { id: "eval-clinician", role: "clinician", practiceId: practice },
    purposeOfUse: "TREAT"
  };
}

export interface Citation {
  readonly resourceId: string;
  readonly path: string;
  readonly rowHash: string;
}
export interface SearchHit {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly score: number;
  readonly citation: Citation;
  readonly freshness: { readonly lastUpdated: string; readonly versionId: string };
}
export interface SearchResponse {
  readonly results: readonly SearchHit[];
  readonly excludedByPolicy: {
    readonly count: number;
    readonly resourceTypes: readonly { readonly resourceType: string; readonly reason: string }[];
  };
  readonly policyReceipt: {
    readonly decision: string;
    readonly resourceType: string;
    readonly practiceId: string;
  };
  readonly auditEventId: string;
}
export interface SearchOutcome {
  readonly ok: boolean;
  readonly error?: string;
  readonly response?: SearchResponse;
  readonly searchDocQueries: number;
  readonly fetchCalls: number;
}

const DEMO = "scripts/search-demo/run.ts";

/** Seed + index a synthetic corpus for a practice via the product write path. */
export function seed(evalId: string, practice: string, corpus: readonly Doc[]): void {
  const run = runArtifact(evalId, ["bun", DEMO, JSON.stringify({ cmd: "seed", practice, corpus })]);
  if (run.status !== 0) fail(evalId, `seed failed:\n${run.output}`);
}

/** Run searchClinical for a practice and return the product outcome + spy counters. */
export function search(evalId: string, practice: string, input: unknown): SearchOutcome {
  const run = runArtifact(evalId, [
    "bun",
    DEMO,
    JSON.stringify({ cmd: "search", practice, input })
  ]);
  if (run.status !== 0) fail(evalId, `search exited ${String(run.status)}:\n${run.output}`);
  return lastJsonLine(evalId, run.output) as SearchOutcome;
}

/** The 8 searchable clinical types (for excludedByPolicy count assertions). */
export const SEARCHABLE_COUNT = 8;
