/**
 * Public surface of the memory spine (H4): the strict bug-patterns KB, the
 * concurrent-safe STATE ledger, the advisory file lock, and the Ratchet that
 * turns recorded bugs into machine-verified guards.
 */
export type { BugPattern, BugPatternsFailure, Guard, GuardType } from "./bug-pattern.js";
export {
  BUG_ID_PATTERN,
  BUG_PATTERNS_FILE,
  bugPatternSchema,
  guardSchema,
  guardTypeSchema,
  parseBugPatterns,
  readBugPatterns
} from "./bug-pattern.js";
export type { LockOptions } from "./file-lock.js";
export { withFileLock } from "./file-lock.js";
export type { RatchetReport, RatchetViolation } from "./ratchet.js";
export {
  checkGuard,
  checkRatchet,
  checkRatchetDocDrift,
  RATCHET_DOC_FILE,
  renderRatchetDoc
} from "./ratchet.js";
export type { LedgerRead, SliceState, StateTransition } from "./state-ledger.js";
export {
  appendTransition,
  currentStates,
  readLedger,
  STATE_LEDGER_FILE,
  sliceStateSchema,
  stateLedgerPath,
  stateTransitionSchema
} from "./state-ledger.js";
