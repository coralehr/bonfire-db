/**
 * Hand-written per-operation adapters behind the generated client. THE U2
 * control lives here: method input types are `Omit<core input, "subject">`
 * (never core's own input schemas, which REQUIRE a caller subject), and the
 * effective core input is `{ ...callerInput, subject }` with the session's
 * subject spread LAST — a `subject` key smuggled into caller input at runtime
 * is always overwritten by the membership-derived one.
 */
import type {
  BonfireError,
  CcpDocument,
  CcpError,
  CcpInput,
  GovernanceError,
  ProposalRecord,
  Result,
  ScribeInput,
  SearchErrorCode,
  SearchInput,
  SearchResponse,
  Subject,
  TenantSql,
  WriteError
} from "@bonfire/core";
import { buildCcp, proposeRecord, searchClinical } from "@bonfire/core";
import type { SdkErrorCode } from "./run-op.js";

/** buildCcp input minus the subject (derived from the session, U2). */
export type BuildCcpInput = Omit<CcpInput, "subject">;
export type BuildCcpResult = Result<CcpDocument, CcpError | BonfireError<SdkErrorCode>>;

/** The typed scribe write input (BF-03); carries no subject at all. */
export type ProposeResourceInput = ScribeInput;
export type ProposeResourceResult = Result<
  ProposalRecord,
  GovernanceError | WriteError | BonfireError<SdkErrorCode>
>;

/** searchClinical input minus the subject (derived from the session, U2). */
export type SearchClinicalInput = Omit<SearchInput, "subject">;
export type SearchClinicalResult = Result<
  SearchResponse,
  BonfireError<SearchErrorCode | SdkErrorCode>
>;

export function opBuildCcp(
  sql: TenantSql,
  subject: Subject,
  input: BuildCcpInput
): Promise<Result<CcpDocument, CcpError>> {
  return buildCcp(sql, { ...input, subject });
}

/**
 * BF-09: propose STAGES a governance proposal — nothing reaches the canonical
 * FHIR store until a clinician approves and commits it. The governance actor
 * IS the session subject (id = audited actor, role/practiceId = membership
 * row): the same U2 control as every other op, so a caller can never name its
 * own role to the governance authority check.
 */
export function opProposeResource(
  sql: TenantSql,
  subject: Subject,
  input: ProposeResourceInput
): Promise<Result<ProposalRecord, GovernanceError | WriteError>> {
  return proposeRecord(sql, { actor: subject, resource: input });
}

export function opSearchClinical(
  sql: TenantSql,
  subject: Subject,
  input: SearchClinicalInput
): Promise<Result<SearchResponse, BonfireError<SearchErrorCode>>> {
  return searchClinical(sql, { ...input, subject });
}
