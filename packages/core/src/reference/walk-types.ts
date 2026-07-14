import type { JsonObject } from "../db/canonical-json.js";
import type { ReferenceProfileName } from "./semantic-catalog.js";

export interface ResourceKey {
  readonly resourceType: string;
  readonly resourceId: string;
}

export interface ReferenceEdge {
  readonly sourceResourceType: string;
  readonly sourceResourceId: string;
  readonly sourceVersionId: string;
  readonly jsonPath: string;
  readonly targetResourceType: string;
  readonly targetResourceId: string;
  readonly targetVersionId: string | null;
}

export interface ReferenceTarget extends ResourceKey {
  readonly versionId: string;
  readonly lastUpdated: string;
  readonly content: JsonObject;
}

export interface ReferenceTargetRequest extends ResourceKey {
  /** Null means the current canonical version; non-null pins history. */
  readonly versionId: string | null;
}

export interface ReferenceGraphReader {
  readEdges(sourceKeys: readonly string[], maxRows: number): Promise<ReferenceEdgePage>;
  resolveTargets(requests: readonly ReferenceTargetRequest[]): Promise<readonly ReferenceTarget[]>;
}

export interface ReferenceEdgePage {
  readonly edges: readonly ReferenceEdge[];
  readonly truncated: boolean;
}

export interface ReferencePathStep {
  readonly source: ResourceKey;
  readonly sourceVersionId: string;
  readonly jsonPath: string;
  readonly target: ResourceKey;
  readonly targetVersionId: string | null;
}

export type ReferencePathStatus = "fetched" | "missing" | "already-present" | "target-limit";

export interface ReferencePathCitation {
  readonly root: ResourceKey;
  readonly depth: number;
  readonly steps: readonly ReferencePathStep[];
  readonly status: ReferencePathStatus;
}

export interface ReferenceTraversalOptions {
  readonly profile: ReferenceProfileName;
  readonly allowedResourceTypes: readonly string[];
  readonly maxDepth: number;
  readonly maxTargets: number;
  readonly maxEdges: number;
  readonly maxCitations: number;
}

export interface ReferenceTraversalResult {
  readonly profile: ReferenceProfileName;
  readonly targets: readonly ReferenceTarget[];
  readonly citations: readonly ReferencePathCitation[];
  readonly stats: {
    readonly consideredEdges: number;
    readonly fetchedTargets: number;
    readonly missingTargets: number;
    readonly alreadyPresentTargets: number;
    readonly targetLimitHits: number;
    readonly edgesOmitted: number;
    readonly citationsOmitted: number;
    readonly uncitedTargetsOmitted: number;
    readonly staleSourceEdges: number;
    readonly missingRoots: number;
    readonly edgeReadTruncated: boolean;
    readonly maxDepthReached: number;
  };
}

export const REFERENCE_TRAVERSAL_LIMITS = {
  resourceIdLength: 64,
  roots: 100,
  allowedResourceTypes: 100,
  depth: 4,
  targets: 128,
  edges: 512,
  citations: 512
} as const;
