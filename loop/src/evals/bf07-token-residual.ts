/**
 * Execution eval bf07-token-residual (BF-07 acceptance 7).
 *
 * On a real search->CCP build, the offline measureCcp token ratio (CCP text vs
 * compact JSON of the identical span set, under the named o200k tokenizer) is
 * >= 1.4x, with ZERO off-box fetch calls — the serialization residual lever, run
 * fully offline. Driven through the product across the harness<->product firewall.
 *
 * Inversion: replacing the CCP text serialization with the compact-JSON baseline
 * (ratio -> ~1.0) -> red.
 */
import {
  buildCcp,
  ccpInput,
  clinicianInput,
  searchResponse,
  seed,
  valueObservation
} from "./bf07-ccp-util.js";
import { fail, pass } from "./eval-util.js";

const EVAL_ID = "bf07-token-residual";
const FLOOR = 1.4;
const practice = crypto.randomUUID();

const corpus = Array.from({ length: 6 }, (_unused, i) =>
  valueObservation(`zzresidual synthetic finding number ${String(i)} with descriptive text`, i + 1)
);
seed(EVAL_ID, practice, corpus);

const response = searchResponse(EVAL_ID, practice, clinicianInput("zzresidual", practice));
const outcome = buildCcp(EVAL_ID, practice, ccpInput(response, practice));

if (!outcome.ok || outcome.doc === undefined)
  fail(EVAL_ID, `ccp not ok: ${JSON.stringify(outcome)}`);
if (outcome.doc.spans.length === 0) fail(EVAL_ID, "no spans to measure");
if (outcome.fetchCalls !== 0)
  fail(EVAL_ID, `token measurement made ${String(outcome.fetchCalls)} off-box calls`);
if (outcome.tokenRatio === undefined || outcome.tokenRatio < FLOOR)
  fail(EVAL_ID, `token ratio ${String(outcome.tokenRatio)} below the ${String(FLOOR)}x floor`);

pass(
  EVAL_ID,
  `CCP is ${outcome.tokenRatio.toFixed(2)}x leaner than compact JSON of the identical span set (offline, 0 fetch)`
);
