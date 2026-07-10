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
  Result,
  ScribeInput,
  SearchErrorCode,
  SearchInput,
  SearchResponse,
  Subject,
  TenantSql,
  WriteError,
  WriteResult
} from "@bonfire/core";
import { buildCcp, searchClinical, writeScribeResource } from "@bonfire/core";
import type { SdkErrorCode } from "./run-op.js";

/** buildCcp input minus the subject (derived from the session, U2). */
export type BuildCcpInput = Omit<CcpInput, "subject">;
export type BuildCcpResult = Result<CcpDocument, CcpError | BonfireError<SdkErrorCode>>;

/** The typed scribe write input (BF-03); carries no subject at all. */
export type ProposeResourceInput = ScribeInput;
export type ProposeResourceResult = Result<WriteResult, WriteError | BonfireError<SdkErrorCode>>;

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

export function opProposeResource(
  sql: TenantSql,
  _subject: Subject,
  input: ProposeResourceInput
): Promise<Result<WriteResult, WriteError>> {
  return writeScribeResource(sql, input);
}

export function opSearchClinical(
  sql: TenantSql,
  subject: Subject,
  input: SearchClinicalInput
): Promise<Result<SearchResponse, BonfireError<SearchErrorCode>>> {
  return searchClinical(sql, { ...input, subject });
}
