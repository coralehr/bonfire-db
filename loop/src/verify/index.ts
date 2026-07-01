/**
 * Public surface of verifier handoff validation (H4): the VERDICT schema and
 * the fail-closed parser. An unparseable or invalid verdict is never a pass.
 */
export type { AcceptanceRow, Verdict, VerdictParseFailure, VerdictStatus } from "./verdict.js";
export {
  acceptanceRowSchema,
  parseVerdict,
  verdictSchema,
  verdictStatusSchema
} from "./verdict.js";
