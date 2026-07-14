/**
 * @bonfire/sql-on-fhir — SQL-on-FHIR v2 ViewDefinition runner (BF-04).
 *
 * One pure projection engine (`evaluateView`) serves both the in-memory HL7
 * conformance runner (`bun run conformance`) and the Postgres vd_* / spidx
 * materializer (`bun run projections:rebuild` + the in-transaction upsert).
 */
export type { LoadedSuite, LoadedSuiteFile } from "./conformance/loader.js";
export { loadSuite } from "./conformance/loader.js";
export type {
  CaseResult,
  ConformanceFailure,
  ConformanceReport,
  OfficialReport
} from "./conformance/report.js";
export { exitCodeForReport, writeReport } from "./conformance/report.js";
export { runSuite } from "./conformance/runner.js";
export type { SuiteCase, SuiteFile, SuiteManifest } from "./conformance/suite-schema.js";
export type { DumpOptions } from "./dump.js";
export { orderedDumpHash } from "./dump.js";
export { evaluateView, validateView } from "./engine/evaluate.js";
export type { EvalScope, Row } from "./engine/selection.js";
export type {
  ProjectionError,
  ProjectionErrorCode,
  SuiteError,
  SuiteErrorCode,
  ViewError,
  ViewErrorCode
} from "./errors.js";
export { commitProjectedProposal } from "./governance.js";
export type { PlannedColumn, TablePlan } from "./materialize/ddl.js";
export { planTable } from "./materialize/ddl.js";
export type { RebuildSummary } from "./materialize/rebuild.js";
export { rebuildProjections } from "./materialize/rebuild.js";
export type { PgColumnType } from "./materialize/type-map.js";
export { pgColumnType } from "./materialize/type-map.js";
export type { UpsertSummary } from "./materialize/upsert.js";
export { upsertProjection } from "./materialize/upsert.js";
export { loadScribeViews } from "./scribe-views.js";
export type { SpidxParamType, SpidxRow } from "./spidx.js";
export { extractSearchParams } from "./spidx.js";
export type {
  MaterializableView,
  SelectNode,
  ViewColumn,
  ViewDefinition
} from "./view-definition.js";
export {
  parseMaterializableView,
  parseViewDefinition,
  RESERVED_COLUMN_NAMES,
  viewDefinitionSchema
} from "./view-definition.js";
export type {
  ProjectedWriteError,
  ProjectedWriteResult,
  ProjectedUpdateResult,
  ReferenceProjector,
  SearchProjector
} from "./write-projected.js";
export {
  updateFhirResourceProjected,
  writeScribeResourceProjected
} from "./write-projected.js";
