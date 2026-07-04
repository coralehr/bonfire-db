/**
 * Stable error codes for the SQL-on-FHIR runner (CQ2: expected failures are
 * `Result` values carrying a machine-readable code, never thrown strings).
 */
import type { BonfireError } from "@bonfire/core";

/** Errors surfaced while validating or evaluating a ViewDefinition. */
export type ViewErrorCode =
  | "VD_INVALID"
  | "VD_FHIRPATH_INVALID"
  | "VD_EVAL_FAILED"
  | "VD_VALUE_NOT_JSON"
  | "VD_COLUMN_MULTIPLE_VALUES"
  | "VD_WHERE_NOT_BOOLEAN"
  | "VD_UNION_COLUMN_MISMATCH"
  | "VD_REPEAT_DEPTH_EXCEEDED";

/** Errors surfaced by the vendored conformance-suite loader. */
export type SuiteErrorCode =
  | "SUITE_FILE_TAMPERED"
  | "SUITE_MANIFEST_MISMATCH"
  | "SUITE_FILE_INVALID";

/** Errors surfaced by the vd table / spidx materializer. */
export type ProjectionErrorCode =
  | "PROJECTION_VIEW_INVALID"
  | "PROJECTION_INVALID_INPUT"
  | "PROJECTION_RESOURCE_NOT_FOUND"
  | "PROJECTION_ROW_INVALID";

export type ViewError = BonfireError<ViewErrorCode>;
export type SuiteError = BonfireError<SuiteErrorCode>;
export type ProjectionError = BonfireError<ProjectionErrorCode>;
