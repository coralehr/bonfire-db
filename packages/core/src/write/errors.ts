/**
 * The write primitive's boundary error contract. Expected failures are typed
 * Result errors with stable codes callers branch on: a scribe input that fails
 * Zod is INVALID_SCRIBE_INPUT; a persistence-layer rejection propagates the
 * fhir-store code unchanged. Genuine DB faults throw so the enclosing withTenant
 * transaction rolls back (no partial write) — they never surface here as allow.
 */
import type { FhirStoreErrorCode } from "../db/fhir-store.js";
import type { BonfireError } from "../result.js";

export type WriteErrorCode = "INVALID_SCRIBE_INPUT" | FhirStoreErrorCode;

export type WriteError = BonfireError<WriteErrorCode>;
