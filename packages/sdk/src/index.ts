/**
 * @bonfire/sdk — the typed client layer over @bonfire/core's published surface.
 *
 * `authenticate` is the ONLY constructor of tenant scope (U2); the generated
 * client and the reactive store are thin typed projections of that one seam.
 */

export type { BonfireError, Result } from "@bonfire/core";
export type {
  AuthenticateDeps,
  AuthenticateError,
  AuthenticateErrorCode,
  BonfireSession,
  SessionVerifyConfig,
  VerifierKeySet
} from "./auth/session.js";
export { authenticate, createSessionVerifier } from "./auth/session.js";
export type { BonfireClient } from "./generated/client.gen.js";
export { createBonfireClient } from "./generated/client.gen.js";
export type {
  BuildCcpInput,
  BuildCcpResult,
  ProposeResourceInput,
  ProposeResourceResult,
  SearchClinicalInput,
  SearchClinicalResult
} from "./ops.js";
export type {
  ClinicalQueryErrorCode,
  ClinicalQueryOptions,
  ClinicalQuerySnapshot,
  ClinicalQueryStore,
  ClinicalRow,
  ListenHandle,
  ProjectionListener
} from "./reactive/use-clinical-query.js";
export { useClinicalQuery } from "./reactive/use-clinical-query.js";
export type { ClinicalView } from "./reactive/views.js";
export { CLINICAL_VIEWS, clinicalViewSchema } from "./reactive/views.js";
export type { OpAdapter, SdkErrorCode } from "./run-op.js";
