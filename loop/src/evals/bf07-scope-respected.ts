/**
 * Execution eval bf07-scope-respected (BF-07 acceptance 8; dangers:
 * scope-after-retrieve + cross-tenant leak).
 *
 * Under practice A's tenant, three FORGED CCP inputs each fail CLOSED, count-only,
 * with practice B's id NEVER present anywhere in the outcome:
 *   (a) a practice-B result id spliced into A's response  -> UNRESOLVED_RESULT
 *       (RLS drops the foreign row), exactly ONE fhir_resources read, ZERO search_doc.
 *   (b) a real A hit relabeled to the wrong resourceType   -> TYPE_MISMATCH,
 *       exactly ONE fhir_resources read, ZERO search_doc.
 *   (c) practice B's whole response (its receipt names B) replayed under A
 *       -> RECEIPT_MISMATCH, ZERO fhir_resources reads (denied BEFORE any read).
 * In every case JSON.stringify(outcome) must not contain B's id.
 *
 * Inversion: neutering the receipt/type/unresolved guard (e.g. receiptMatches -> true)
 * -> a laundered/foreign/relabeled hit resolves or reads when it must not -> red.
 */

import type { CcpOutcome, SearchResponse } from "./bf07-ccp-util.js";
import {
  buildCcp,
  ccpInput,
  clinicianInput,
  searchResponse,
  seed,
  valueObservation
} from "./bf07-ccp-util.js";
import { fail, pass } from "./eval-util.js";

const EVAL_ID = "bf07-scope-respected";
// The observation value is irrelevant to the scope test; only the id/type/tenant matter.
const V1 = 1;
const V2 = 2;
const practiceA = crypto.randomUUID();
const practiceB = crypto.randomUUID();

seed(EVAL_ID, practiceA, [
  valueObservation("zzscopea alpha finding", V1),
  valueObservation("zzscopea beta finding", V2)
]);
seed(EVAL_ID, practiceB, [
  valueObservation("zzscopeb gamma finding", V1),
  valueObservation("zzscopeb delta finding", V2)
]);

const responseA = searchResponse(EVAL_ID, practiceA, clinicianInput("zzscopea", practiceA));
const responseB = searchResponse(EVAL_ID, practiceB, clinicianInput("zzscopeb", practiceB));
if (responseA.results.length === 0) fail(EVAL_ID, "practice A search returned no results");
if (responseB.results.length === 0) fail(EVAL_ID, "practice B search returned no results");

const bHit = responseB.results[0];
const aHit = responseA.results[0];
if (bHit === undefined || aHit === undefined) fail(EVAL_ID, "missing a seed hit to forge with");
const bId = bHit.resourceId;

/** Assert one forged input fails closed with the expected code, reads, and no B-id leak. */
function assertClosed(
  label: string,
  forged: SearchResponse,
  expectedCode: string,
  expectedFhirReads: number
): CcpOutcome {
  const out = buildCcp(EVAL_ID, practiceA, ccpInput(forged, practiceA));
  if (out.ok) fail(EVAL_ID, `${label}: expected fail-closed, got ok ${JSON.stringify(out)}`);
  if (out.error !== expectedCode)
    fail(EVAL_ID, `${label}: expected ${expectedCode}, got ${String(out.error)}`);
  if (out.fhirResourceReads !== expectedFhirReads)
    fail(
      EVAL_ID,
      `${label}: expected ${String(expectedFhirReads)} fhir_resources read(s), got ${String(out.fhirResourceReads)}`
    );
  if (out.searchDocQueries !== 0)
    fail(EVAL_ID, `${label}: read search_doc ${String(out.searchDocQueries)} times (CCP must not)`);
  if (out.doc !== undefined) fail(EVAL_ID, `${label}: a document materialized on a denied path`);
  if (JSON.stringify(out).includes(bId))
    fail(EVAL_ID, `${label}: practice B id leaked into the outcome`);
  return out;
}

// (a) splice a practice-B result id into A's response -> RLS drops it -> UNRESOLVED_RESULT.
const spliced: SearchResponse = {
  ...responseA,
  results: [...responseA.results, { ...aHit, resourceId: bId }]
};
assertClosed("spliced-foreign-id", spliced, "UNRESOLVED_RESULT", 1);

// (b) relabel a real A hit's resourceType (it is an Observation) -> TYPE_MISMATCH.
const relabeled: SearchResponse = {
  ...responseA,
  results: [{ ...aHit, resourceType: "Condition" }, ...responseA.results.slice(1)]
};
assertClosed("relabeled-type", relabeled, "TYPE_MISMATCH", 1);

// (c) replay practice B's whole response (receipt names B) under A -> RECEIPT_MISMATCH, ZERO reads.
assertClosed("laundered-receipt", responseB, "RECEIPT_MISMATCH", 0);

pass(
  EVAL_ID,
  "forged foreign-id / relabeled-type / laundered-receipt all fail closed count-only; single-or-zero read; no B-id leak"
);
