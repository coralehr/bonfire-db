/**
 * Execution eval bf07-result-boundary (BF-07 acceptance 1; CQ2 idiom).
 *
 * buildCcp returns a Result discriminated union at the public boundary: malformed
 * input yields a typed `err` (MALFORMED_INPUT) and NEVER throws across the
 * boundary — a thrown exception would surface as the tenant-tx failure code, not
 * a typed CCP error, so asserting the MALFORMED_INPUT code proves the clean
 * boundary. Valid input yields `ok`. Driven through the product.
 *
 * Inversion: dropping the Zod parse guard so malformed input flows in and throws
 * -> the error code becomes TENANT_TX_FAILED (or a crash), not MALFORMED_INPUT -> red.
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

const EVAL_ID = "bf07-result-boundary";
const OBS_VALUE = 3;
const practice = crypto.randomUUID();

seed(EVAL_ID, practice, [valueObservation("zzboundary clinical finding", OBS_VALUE)]);
const response = searchResponse(EVAL_ID, practice, clinicianInput("zzboundary", practice));

// Valid input -> ok.
const good = buildCcp(EVAL_ID, practice, ccpInput(response, practice));
if (!good.ok || good.doc === undefined)
  fail(EVAL_ID, `valid input not ok: ${JSON.stringify(good)}`);

// Malformed inputs -> a typed MALFORMED_INPUT err, never a throw.
const subject = { id: "eval-clinician", role: "clinician", practiceId: practice };
const malformed: unknown[] = [
  {}, // missing every field
  { response: response, subject, purposeOfUse: "NOT_A_PURPOSE" }, // bad purpose enum
  { response: { ...response, results: "not-an-array" }, subject, purposeOfUse: "TREAT" }, // bad shape
  { response: { ...response, auditEventId: 42 }, subject, purposeOfUse: "TREAT" } // wrong type
];

for (const input of malformed) {
  const out = buildCcp(EVAL_ID, practice, input);
  if (out.ok) fail(EVAL_ID, `malformed input returned ok: ${JSON.stringify(input)}`);
  if (out.error !== "MALFORMED_INPUT")
    fail(
      EVAL_ID,
      `malformed input threw past the boundary (error=${String(out.error)}), not a MALFORMED_INPUT Result`
    );
  if (out.fhirResourceReads !== 0)
    fail(
      EVAL_ID,
      `a pre-parse malformed input read fhir_resources ${String(out.fhirResourceReads)} times`
    );
}

pass(
  EVAL_ID,
  "valid input -> ok; 4 malformed inputs -> typed MALFORMED_INPUT err with zero reads, no throw"
);
