/**
 * Public surface of the loop harness slice-contract system.
 *
 * The contracts module owns the typed unit of work the loop gates: the Zod slice
 * schema, the default-deny allowed-paths check, and the validated BF-01..BF-13
 * registry. Re-exported here so consumers import from one entry point.
 */

export type { AllowedPathsFailure, AllowedPathsViolation } from "./allowed-paths.js";
export { checkAllowedPaths, GLOBAL_FORBIDDEN_PATHS } from "./allowed-paths.js";
export type { RegistryFailure, RegistryIssue, RegistryValidation } from "./registry.js";
export { allSlices, getSlice, validateEntries, validateRegistry } from "./registry.js";
export type { Result } from "./result.js";
export { err, ok } from "./result.js";
export type { DangerCheck, RequiredAgent, SliceContract, SliceProfile } from "./slice-contract.js";
export {
  dangerCheckSchema,
  requiredAgentSchema,
  SLICE_ID_PATTERN,
  sliceContractSchema,
  sliceProfileSchema
} from "./slice-contract.js";
