/**
 * An execution-watching eval case (Stage 2). Closed DATA, validated by a fixed
 * Zod schema — the H1 "no prose auto-parsing" posture, same as the slice
 * registry and the bug-patterns KB. There is no assertion grammar to interpret:
 * a case names an argv that PASSES iff it exits 0, and the rich assertion lives
 * inside the thing that argv runs. An eval must run the BUILT artifact and
 * assert behavior nothing else already asserts (the Stage-1 `test` gate already
 * runs the unit tests) — otherwise it is relabeling, not an eval.
 */
import { z } from "zod";
import { SLICE_ID_PATTERN } from "./slice-contract.js";

/** e.g. "bf02-scanner-error-redacts-content" — <slice-lower><n>-<kebab>. */
const EVAL_ID_PATTERN = /^bf\d{2}-[a-z][a-z0-9-]*$/;

const nonEmptyString = z.string().min(1);

export const evalCaseSchema = z.strictObject({
  id: z.string().regex(EVAL_ID_PATTERN, "id must match /^bf\\d{2}-[a-z][a-z0-9-]*$/"),
  slice: z.string().regex(SLICE_ID_PATTERN, "slice must be a BF-NN id"),
  /** The BP-id or acceptance criterion this eval protects (provenance). */
  traces: nonEmptyString,
  /** argv run by the Stage-2 gate; PASS iff it exits 0 (commandGate semantics). */
  run: z.strictObject({
    command: z.array(nonEmptyString).min(1)
  })
});
export type EvalCase = z.infer<typeof evalCaseSchema>;
