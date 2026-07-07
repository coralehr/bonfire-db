/**
 * Execution eval bf06-no-phi-egress (BF-06 acceptance 3; danger: PHI egress).
 *
 * In the default config the search path makes ZERO off-box calls: the product is
 * driven with a globalThis.fetch spy and a real, results-returning search must
 * report fetchCalls === 0 (the dev embedder is node:crypto; the reranker is off).
 * Non-vacuous: the search actually ran and returned a hit.
 *
 * Inversion: an external embedding/rerank call in the default path -> fetchCalls > 0
 * -> red (complements the structural sgrule BP-035).
 */

import { clinicianInput, observation, search, seed } from "./bf06-search-util.js";
import { fail, pass } from "./eval-util.js";

const EVAL_ID = "bf06-no-phi-egress";
const practice = crypto.randomUUID();
seed(EVAL_ID, practice, [observation("zzegress", "shortness of breath")]);

const out = search(EVAL_ID, practice, clinicianInput("zzegress", practice));
if (!out.ok || out.response === undefined) fail(EVAL_ID, `search failed: ${JSON.stringify(out)}`);
if (out.response.results.length === 0)
  fail(EVAL_ID, "vacuous: the default search returned no results");
if (out.fetchCalls !== 0)
  fail(
    EVAL_ID,
    `PHI EGRESS: the default search made ${String(out.fetchCalls)} off-box fetch call(s)`
  );

pass(
  EVAL_ID,
  `default search returned ${String(out.response.results.length)} hit(s) with 0 off-box fetch calls`
);
