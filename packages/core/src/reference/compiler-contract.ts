/**
 * Storage-neutral contract for a governed evidence compiler. This module has
 * no SQL, Cypher, or storage-engine dependency: Postgres query-time traversal,
 * a materialized edge projection, or a future engine must all satisfy these
 * exact bounded inputs and cited outputs.
 *
 * An executable public compiler is intentionally not exposed yet. Bonfire's
 * v0 ABAC type scope does not include several measured QT-4 resource types
 * (DiagnosticReport, Specimen, ServiceRequest), so wiring retrieval first
 * would create a scope-after-retrieve bug. The contract can land now; the
 * product adapter must wait for a separately reviewed policy expansion.
 */
import { z } from "zod";
import { PURPOSES_OF_USE, ROLES } from "../abac/types.js";
import { REFERENCE_PROFILE_NAMES } from "./semantic-catalog.js";
import {
  REFERENCE_TRAVERSAL_LIMITS,
  type ReferencePathCitation,
  type ReferenceTraversalResult,
  type ResourceKey
} from "./walk.js";

export const EVIDENCE_COMPILER_CONTRACT_VERSION = "evidence-compiler/v1";

const resourceKeySchema = z.object({
  resourceType: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
  resourceId: z.string().min(1).max(REFERENCE_TRAVERSAL_LIMITS.resourceIdLength)
});

export const evidenceCompileRequestSchema = z.object({
  contractVersion: z.literal(EVIDENCE_COMPILER_CONTRACT_VERSION),
  plan: z.object({
    profile: z.enum(REFERENCE_PROFILE_NAMES),
    roots: z.array(resourceKeySchema).min(1).max(REFERENCE_TRAVERSAL_LIMITS.roots),
    maxDepth: z.number().int().min(1).max(REFERENCE_TRAVERSAL_LIMITS.depth),
    maxTargets: z.number().int().min(1).max(REFERENCE_TRAVERSAL_LIMITS.targets),
    maxEdges: z.number().int().min(1).max(REFERENCE_TRAVERSAL_LIMITS.edges),
    maxCitations: z.number().int().min(1).max(REFERENCE_TRAVERSAL_LIMITS.citations)
  }),
  principal: z.object({
    id: z.string().min(1),
    role: z.enum(ROLES),
    practiceId: z.uuid()
  }),
  purposeOfUse: z.enum(PURPOSES_OF_USE),
  sourceVersion: z.object({
    snapshotId: z.string().min(1),
    asOf: z.iso.datetime()
  })
});

export type EvidenceCompileRequest = z.infer<typeof evidenceCompileRequestSchema>;

export interface EvidencePacketResource extends ResourceKey {
  readonly versionId: string;
  readonly lastUpdated: string;
  readonly content: Readonly<Record<string, unknown>>;
}

export interface EvidenceCompileReceipt {
  readonly contractVersion: typeof EVIDENCE_COMPILER_CONTRACT_VERSION;
  /** Canonical SHA-256 of the full validated request, including principal and source version. */
  readonly requestSha256: string;
  /** Canonical SHA-256 of plan roots, profile, and every traversal bound. */
  readonly planSha256: string;
  readonly snapshotId: string;
  readonly sourceAsOf: string;
  readonly principalId: string;
  readonly practiceId: string;
  readonly purposeOfUse: EvidenceCompileRequest["purposeOfUse"];
  readonly profile: EvidenceCompileRequest["plan"]["profile"];
  readonly packetSha256: string;
  readonly projectionSha256: string;
}

export interface EvidenceCompileResult {
  readonly resources: readonly EvidencePacketResource[];
  readonly pathCitations: readonly ReferencePathCitation[];
  readonly traversal: ReferenceTraversalResult["stats"];
  readonly receipt: EvidenceCompileReceipt;
}

export interface EvidenceCompiler {
  compileEvidence(request: EvidenceCompileRequest): Promise<EvidenceCompileResult>;
}
