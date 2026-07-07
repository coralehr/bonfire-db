/**
 * Execution eval bf06-default-deny (BF-06 acceptance 6 + danger: fail-open-authz).
 *
 * A candidate whose ABAC decision is anything other than an explicit allow is
 * placed in excludedByPolicy and NEVER in results. A biller (non-clinician) role
 * is a non-allow decision on every clinical type. The allow control proves the
 * gate is not simply denying everything.
 *
 * Inversion: a fail-open ("return on non-allow") change surfaces results for the
 * biller -> red.
 */

import { clinicianInput, observation, SEARCHABLE_COUNT, search, seed } from "./bf06-search-util.js";
import { fail, pass } from "./eval-util.js";

const EVAL_ID = "bf06-default-deny";
const practice = crypto.randomUUID();
seed(EVAL_ID, practice, [observation("zzdeny", "a note")]);

const billerInput = {
  query: "zzdeny",
  subject: { id: "biller-1", role: "biller", practiceId: practice },
  purposeOfUse: "TREAT"
};
const denied = search(EVAL_ID, practice, billerInput);
if (!denied.ok || denied.response === undefined)
  fail(EVAL_ID, `biller search failed: ${JSON.stringify(denied)}`);
if (denied.response.results.length !== 0) {
  fail(
    EVAL_ID,
    `FAIL-OPEN: a non-allow (biller) decision returned ${String(denied.response.results.length)} results`
  );
}
if (
  denied.response.excludedByPolicy.count !== SEARCHABLE_COUNT ||
  denied.response.policyReceipt.decision !== "deny"
) {
  fail(EVAL_ID, `biller not default-denied: ${JSON.stringify(denied.response.excludedByPolicy)}`);
}

const allowed = search(EVAL_ID, practice, clinicianInput("zzdeny", practice));
if (!allowed.ok || allowed.response === undefined || allowed.response.results.length === 0) {
  fail(EVAL_ID, `control failed: a clinician/TREAT search returned no results`);
}

pass(
  EVAL_ID,
  `biller -> 0 results + ${String(SEARCHABLE_COUNT)} excluded (deny); clinician/TREAT -> results returned`
);
