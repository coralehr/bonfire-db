/**
 * @bonfire/core public surface.
 *
 * `withTenant` (via connectTenantDb) is the ONLY query path: the raw postgres
 * client is deliberately not exported, so every consumer read/write runs inside
 * a transaction whose tenant GUC drives the fail-closed RLS policies.
 */
export type { JsonObject, JsonValue } from "./db/canonical-json.js";
export { canonicalizeJson, contentHash } from "./db/canonical-json.js";
export type { DatabaseTarget, EnvMap } from "./db/env.js";
export { resolveDatabaseTarget } from "./db/env.js";
export type {
  FhirResourceRecord,
  FhirStoreErrorCode,
  InsertFhirResourceInput,
  UpdateFhirResourceInput
} from "./db/fhir-store.js";
export { insertFhirResourceTx, jsonValueSchema, updateFhirResourceTx } from "./db/fhir-store.js";
export type { MigrateErrorCode } from "./db/migrate.js";
export { runMigrations } from "./db/migrate.js";
export type { TenantDb, TenantSql, WithTenantErrorCode } from "./db/tenant.js";
export { connectTenantDb } from "./db/tenant.js";
export type { BonfireError, Result } from "./result.js";
export { err, ok } from "./result.js";
