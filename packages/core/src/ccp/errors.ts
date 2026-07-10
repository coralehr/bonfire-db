/**
 * CCP boundary error codes (CQ2 idiom): expected, recoverable failures surface
 * as values carrying a stable machine-readable code callers branch on. Every
 * deny-shaped error carries a COUNT only — never a resource id, because a
 * returned id for a row the caller could not read is a cross-tenant existence
 * oracle (BP-019 rule).
 */
import type { BonfireError } from "../result.js";

export type CcpErrorCode =
  | "MALFORMED_INPUT"
  | "UNRESOLVED_RESULT"
  | "SCOPE_EXCLUDED_TYPE"
  | "TYPE_MISMATCH"
  | "RECEIPT_MISMATCH";

export interface CcpError extends BonfireError<CcpErrorCode> {
  /** How many hits tripped the guard — a count only, ids are never surfaced. */
  readonly count?: number;
}
