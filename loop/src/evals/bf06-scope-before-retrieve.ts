/**
 * Execution eval bf06-scope-before-retrieve (BF-06 acceptance 5 + danger:
 * scope-after-retrieve; closes ratchet BP-006).
 *
 * The ABAC scope is applied BEFORE any row is fetched: a denied request executes
 * ZERO reads against search_doc (proven by the product-side query spy), so no
 * out-of-scope row can enter the candidate set. The non-vacuous control: an
 * allowed clinician/TREAT search DOES read search_doc, so the spy is real.
 *
 * Inversion: a "fetch then filter" rewrite makes the denied search read search_doc
 * (searchDocQueries > 0) -> red.
 */

import { clinicianInput, observation, SEARCHABLE_COUNT, search, seed } from "./bf06-search-util.js";
import { fail, pass } from "./eval-util.js";

const EVAL_ID = "bf06-scope-before-retrieve";
const practice = crypto.randomUUID();
const doc = observation("zzscope", "chest pain note");

seed(EVAL_ID, practice, [doc]);

// DENY: a non-TREAT purpose -> every type denied -> zero fusion SQL.
const denyInput = {
  query: "zzscope",
  subject: { id: "biller-1", role: "clinician", practiceId: practice },
  purposeOfUse: "HPAYMT"
};
const denied = search(EVAL_ID, practice, denyInput);
if (!denied.ok || denied.response === undefined)
  fail(EVAL_ID, `deny search failed: ${JSON.stringify(denied)}`);
if (denied.searchDocQueries !== 0) {
  fail(
    EVAL_ID,
    `SCOPE-AFTER-RETRIEVE: denied search read search_doc ${String(denied.searchDocQueries)} times`
  );
}
if (
  denied.response.results.length !== 0 ||
  denied.response.excludedByPolicy.count !== SEARCHABLE_COUNT
) {
  fail(EVAL_ID, `deny not fully excluded: ${JSON.stringify(denied.response.excludedByPolicy)}`);
}

// Non-vacuous control: an allowed search DOES read search_doc.
const allowed = search(EVAL_ID, practice, clinicianInput("zzscope", practice));
if (!allowed.ok || allowed.searchDocQueries === 0) {
  fail(EVAL_ID, `control failed: an allowed search read 0 search_doc queries (spy is vacuous)`);
}

pass(
  EVAL_ID,
  `deny -> 0 search_doc reads + ${String(SEARCHABLE_COUNT)} excluded; allow -> ${String(allowed.searchDocQueries)} reads`
);
