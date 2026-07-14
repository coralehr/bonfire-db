/**
 * @bonfire/core public surface.
 *
 * `withTenant` (via connectTenantDb) is the ONLY query path: the raw postgres
 * client is deliberately not exported, so every consumer read/write runs inside
 * a transaction whose tenant GUC drives the fail-closed RLS policies.
 */
export { decide } from "./abac/decide.js";
export type {
  AccessScope,
  Decision,
  PolicyReceipt,
  PurposeOfUse,
  ReceiptPurpose,
  ResourceAttrs,
  Role,
  Subject
} from "./abac/types.js";
export { accessScopeSchema, PURPOSES_OF_USE, ROLES } from "./abac/types.js";
export { appendAuditRowTx, authorizeAndAudit } from "./audit/audit-log.js";
export type { AuditLogicalFields } from "./audit/row-hash.js";
export {
  AUDIT_CHAIN_DOMAIN,
  auditRowHash,
  GENESIS_PREV_HASH,
  SHA256_HEX_LENGTH
} from "./audit/row-hash.js";
export type { AuditChainReport, AuditChainRow, ChainBreakReason } from "./audit/verify.js";
export { verifyAuditChainTx, walkChain } from "./audit/verify.js";
export type { AuthAuditResult, AuthFailure } from "./auth/auth-audit.js";
export {
  auditAuthFailure,
  auditAuthSuccess,
  buildAuthReceipt,
  SYSTEM_PRACTICE_ID
} from "./auth/auth-audit.js";
export type { AuthError, AuthErrorCode } from "./auth/errors.js";
export type { VerifiedIdentity, VerifyTokenConfig } from "./auth/types.js";
export { DEFAULT_FHIR_USER_CLAIM, verifiedClaimsSchema } from "./auth/types.js";
export type { Verifier } from "./auth/verify-token.js";
export { createVerifier, verifyToken } from "./auth/verify-token.js";
export { buildCcp } from "./ccp/build-ccp.js";
export { ccpContentDigest } from "./ccp/content-digest.js";
export type { CcpError, CcpErrorCode } from "./ccp/errors.js";
export { LEAF_PATHS, resolvePath } from "./ccp/leaf-paths.js";
export type {
  CcpDocument,
  CcpInput,
  CcpSpan,
  CcpSpanDraft,
  CcpSpanValue
} from "./ccp/schemas.js";
export { CCP_VERSION, ccpDocumentSchema, ccpInputSchema } from "./ccp/schemas.js";
export type { CcpTokenMeasurement, TokenCounter } from "./ccp/token-count.js";
export { measureCcp, o200kCounter } from "./ccp/token-count.js";
export type { JsonObject, JsonValue } from "./db/canonical-json.js";
export { canonicalizeJson, contentHash, sha256Hex } from "./db/canonical-json.js";
export type { DatabaseTarget, EnvMap } from "./db/env.js";
export { devDatabaseUrl, resolveDatabaseTarget } from "./db/env.js";
export type {
  FhirResourceRecord,
  FhirStoreErrorCode,
  InsertFhirResourceInput,
  UpdateFhirResourceInput
} from "./db/fhir-store.js";
export { insertFhirResourceTx, jsonValueSchema, updateFhirResourceTx } from "./db/fhir-store.js";
export type { MigrateErrorCode } from "./db/migrate.js";
export { runMigrations } from "./db/migrate.js";
export type {
  Membership,
  ResolveMembershipErrorCode,
  TenantDb,
  TenantSql,
  WithTenantErrorCode
} from "./db/tenant.js";
export { connectTenantDb } from "./db/tenant.js";
export type { FhirCodingRef } from "./fhir/codings.js";
export { collectCodings } from "./fhir/codings.js";
export { parseJsonValue, toJsonObject } from "./fhir/json.js";
export type {
  LossLedgerEntry,
  RoundTripEvaluation,
  RoundTripViolation
} from "./fhir/loss-ledger.js";
export { evaluateRoundTrip, parseLossLedger } from "./fhir/loss-ledger.js";
export type { MapperError, MapperErrorCode, RoundTrip } from "./fhir/mappers.js";
export { fromFhir, roundTrip, toFhir } from "./fhir/mappers.js";
export { US_CORE_PROFILES } from "./fhir/profiles.js";
export type { JsonDiffKind, RoundTripDiff } from "./fhir/roundtrip-diff.js";
export { decimalDiffs, structuralDiffs } from "./fhir/roundtrip-diff.js";
export type { ScribeInput, ScribeResourceType } from "./fhir/scribe-schemas.js";
export { scribeInputSchema } from "./fhir/scribe-schemas.js";
export { decideGovernance, transition } from "./governance/policy.js";
export type { GovernanceCommitWriter } from "./governance/store.js";
export { approveProposal, commitProposal, proposeRecord } from "./governance/store.js";
export type {
  GovernanceAction,
  GovernanceActor,
  GovernanceError,
  GovernanceErrorCode,
  GovernanceRole,
  GovernanceState,
  ProposalRecord,
  SignedNote
} from "./governance/types.js";
export { GOVERNANCE_ROLES, GOVERNANCE_STATES, signedNoteSchema } from "./governance/types.js";
export type { BonfireError, Result } from "./result.js";
export { err, ok } from "./result.js";
export type { ExplicitReference } from "./reference/extract.js";
export { extractExplicitReferences } from "./reference/extract.js";
export type {
  EvidenceCompileReceipt,
  EvidenceCompileRequest,
  EvidenceCompileResult,
  EvidenceCompiler,
  EvidencePacketResource
} from "./reference/compiler-contract.js";
export {
  EVIDENCE_COMPILER_CONTRACT_VERSION,
  evidenceCompileRequestSchema
} from "./reference/compiler-contract.js";
export type {
  ReferenceProjectionComparison,
  ReferenceProjectionErrorCode,
  ReferenceProjectionSummary
} from "./reference/projection.js";
export {
  compareReferenceProjectionTx,
  replaceReferenceEdgesTx
} from "./reference/projection.js";
export type {
  ReferenceEvidenceStatus,
  ReferenceProfile,
  ReferenceProfileName,
  ReferenceRule
} from "./reference/semantic-catalog.js";
export {
  REFERENCE_PROFILE_NAMES,
  REFERENCE_PROFILES,
  isAllowedReferenceEdge,
  referenceProfile
} from "./reference/semantic-catalog.js";
export type {
  ReferenceEdge,
  ReferenceEdgePage,
  ReferenceGraphReader,
  ReferencePathCitation,
  ReferencePathStatus,
  ReferencePathStep,
  ReferenceTarget,
  ReferenceTargetRequest,
  ReferenceTraversalOptions,
  ReferenceTraversalResult,
  ResourceKey
} from "./reference/walk.js";
// The executable SQL reader and walker remain internal until the governed
// compiler derives ABAC scope and purpose before retrieval. Only bounded
// contract types and constants are public in this release.
export { REFERENCE_TRAVERSAL_LIMITS } from "./reference/walk.js";
export type { DerivedScope, ScopeSubject } from "./search/derive-scope.js";
export { deriveScope, isSearchableType, SEARCHABLE_TYPES } from "./search/derive-scope.js";
export { DEV_MODEL_ID, devEmbedder, isZeroEmbedding } from "./search/dev-embedder.js";
export type { IndexErrorCode, IndexSummary } from "./search/index-doc.js";
export { indexResourceTx } from "./search/index-doc.js";
export type {
  EmbeddingProvider,
  ExcludedType,
  RerankProvider,
  SearchConfig,
  SearchHit,
  SearchInput,
  SearchResponse
} from "./search/schemas.js";
export { EMBEDDING_DIM, searchInputSchema, searchResponseSchema } from "./search/schemas.js";
export type { SearchErrorCode } from "./search/search-clinical.js";
export { searchClinical } from "./search/search-clinical.js";
export type { TerminologyConceptLookup } from "./terminology/bundled-pack-validator.js";
export { createBundledPackValidator } from "./terminology/bundled-pack-validator.js";
export { createSqlConceptLookup } from "./terminology/concept-lookup.js";
export { isSnomedSystem, isValidSctid } from "./terminology/snomed-format.js";
export type {
  TerminologyValidator,
  ValidateCodeRequest,
  ValidateCodeResult
} from "./terminology/validator.js";
export {
  createRemoteTxValidator,
  TerminologyNotImplementedError
} from "./terminology/validator.js";
export type { WriteError, WriteErrorCode } from "./write/errors.js";
export type { TerminologyReport, TerminologyWarning } from "./write/terminology-check.js";
export { checkResourceTerminology } from "./write/terminology-check.js";
export type { WriteResult } from "./write/write-resource.js";
export { writeScribeResource } from "./write/write-resource.js";
