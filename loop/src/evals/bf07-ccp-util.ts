/**
 * Shared scaffolding for the BF-07 Stage-2 evals. Drives the PRODUCT CCP path
 * through scripts/search-demo/run.ts (cmd "ccp") across the harness<->product
 * firewall — the evals cannot import @bonfire/core — then asserts on the returned
 * CcpDocument + read/egress spy counters. Reuses the BF-06 seed/search helpers so
 * a CCP is always built from a REAL searchClinical response. Synthetic-only.
 */
import { clinicianInput, type Doc, observation, search, seed } from "./bf06-search-util.js";
import { fail, lastJsonLine, runArtifact } from "./eval-util.js";

// Reuse the BF-06 seed + search drivers verbatim (a CCP is always built from a
// REAL search response); only the buildCcp driver is BF-07-specific.
export { clinicianInput, type Doc, observation, seed };

const SYNTH_SYSTEM = "http://example.org/synthetic";
const DEMO = "scripts/search-demo/run.ts";

/** A synthetic Condition carrying a coded display, a code, and a free-text note. */
export function condition(display: string, note: string): Doc {
  const id = crypto.randomUUID();
  return {
    id,
    type: "Condition",
    content: {
      resourceType: "Condition",
      id,
      code: { coding: [{ system: SYNTH_SYSTEM, code: "cond-1", display }], text: display },
      clinicalStatus: { coding: [{ code: "active" }] },
      onsetDateTime: "2024-01-15",
      note: [{ text: note }]
    }
  };
}

/** A synthetic Observation with a numeric value plus a searchable coded display. */
export function valueObservation(display: string, value: number): Doc {
  const id = crypto.randomUUID();
  return {
    id,
    type: "Observation",
    content: {
      resourceType: "Observation",
      id,
      status: "final",
      code: { coding: [{ system: SYNTH_SYSTEM, code: "obs-1", display }] },
      valueQuantity: { value, unit: "mmol/L" },
      note: [{ text: display }]
    }
  };
}

export interface CcpSpan {
  readonly resourceId: string;
  readonly resourceType: string;
  readonly jsonPath: string;
  readonly value: string | number | boolean;
  readonly auditHash: string;
  readonly lastUpdated: string;
  readonly versionId: string;
}

export interface CcpDocument {
  readonly version: string;
  readonly auditEventId: string;
  readonly practiceId: string;
  readonly generatedAt: string;
  readonly spans: readonly CcpSpan[];
  readonly excludedByPolicy: {
    readonly count: number;
    readonly resourceTypes: readonly { readonly resourceType: string; readonly reason: string }[];
  };
  readonly text: string;
}

export interface CcpOutcome {
  readonly ok: boolean;
  readonly error?: string;
  readonly doc?: CcpDocument;
  readonly fhirResourceReads: number;
  readonly searchDocQueries: number;
  readonly fetchCalls: number;
  readonly tokenRatio?: number;
}

/** The BF-06 SearchResponse shape the eval forges/relays into buildCcp input. */
export interface SearchResponse {
  readonly results: readonly {
    readonly resourceType: string;
    readonly resourceId: string;
    readonly score: number;
    readonly citation: {
      readonly resourceId: string;
      readonly path: string;
      readonly rowHash: string;
    };
    readonly freshness: { readonly lastUpdated: string; readonly versionId: string };
  }[];
  readonly excludedByPolicy: {
    readonly count: number;
    readonly resourceTypes: readonly { readonly resourceType: string; readonly reason: string }[];
  };
  readonly policyReceipt: {
    readonly decision: string;
    readonly actorId: string;
    readonly purposeOfUse: string;
    readonly practiceId: string;
    readonly resourceType: string;
    readonly timestamp: string;
  };
  readonly auditEventId: string;
}

/** Run a REAL searchClinical (BF-06 driver) and return its full policy-scoped
 * response — the CCP input the eval relays or forges. The runtime object carries
 * the complete receipt (actorId/purposeOfUse/timestamp) buildCcp cross-checks;
 * the narrower BF-06 SearchResponse type is widened here to the CCP shape. */
export function searchResponse(evalId: string, practice: string, input: unknown): SearchResponse {
  const outcome = search(evalId, practice, input);
  if (!outcome.ok || outcome.response === undefined)
    fail(evalId, `search not ok: ${JSON.stringify(outcome)}`);
  return outcome.response as unknown as SearchResponse;
}

/** Run buildCcp on a (possibly forged) CcpInput and return the product outcome. */
export function buildCcp(evalId: string, practice: string, input: unknown): CcpOutcome {
  const run = runArtifact(evalId, ["bun", DEMO, JSON.stringify({ cmd: "ccp", practice, input })]);
  if (run.status !== 0) fail(evalId, `ccp exited ${String(run.status)}:\n${run.output}`);
  return lastJsonLine(evalId, run.output) as CcpOutcome;
}

/** Assemble a CcpInput from a (real or forged) response for a clinician/TREAT build. */
export function ccpInput(response: SearchResponse, practice: string): unknown {
  return {
    response,
    subject: { id: "eval-clinician", role: "clinician", practiceId: practice },
    purposeOfUse: "TREAT"
  };
}

export interface BuiltCcp {
  readonly doc: CcpDocument;
  readonly response: SearchResponse;
}

/**
 * The happy-path preamble shared by the citation + audit evals: seed a corpus,
 * run a REAL search for `query`, build the CCP, and return the ok document plus
 * the search response (its auditEventId is the source id folded into the digest).
 * Fails the eval unless the build is ok with at least one span.
 */
export function buildCcpDoc(
  evalId: string,
  practice: string,
  corpus: readonly Doc[],
  query: string
): BuiltCcp {
  seed(evalId, practice, corpus);
  const response = searchResponse(evalId, practice, clinicianInput(query, practice));
  const outcome = buildCcp(evalId, practice, ccpInput(response, practice));
  if (!outcome.ok || outcome.doc === undefined)
    fail(evalId, `ccp not ok: ${JSON.stringify(outcome)}`);
  if (outcome.doc.spans.length === 0) fail(evalId, "ccp produced no spans");
  return { doc: outcome.doc, response };
}
