import { z } from "zod";
import { REFERENCE_PROFILE_NAMES } from "./semantic-catalog.js";
import {
  REFERENCE_TRAVERSAL_LIMITS,
  type ReferencePathCitation,
  type ReferencePathStep,
  type ReferenceTarget,
  type ReferenceTargetRequest,
  type ReferenceTraversalOptions,
  type ResourceKey
} from "./walk-types.js";

const resourceKeySchema = z.object({
  resourceType: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
  resourceId: z.string().min(1).max(REFERENCE_TRAVERSAL_LIMITS.resourceIdLength)
});

const optionsSchema = z.object({
  profile: z.enum(REFERENCE_PROFILE_NAMES),
  allowedResourceTypes: z
    .array(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/))
    .min(1)
    .max(REFERENCE_TRAVERSAL_LIMITS.allowedResourceTypes),
  maxDepth: z.number().int().min(1).max(REFERENCE_TRAVERSAL_LIMITS.depth),
  maxTargets: z.number().int().min(1).max(REFERENCE_TRAVERSAL_LIMITS.targets),
  maxEdges: z.number().int().min(1).max(REFERENCE_TRAVERSAL_LIMITS.edges),
  maxCitations: z.number().int().min(1).max(REFERENCE_TRAVERSAL_LIMITS.citations)
});

export interface FrontierNode {
  readonly key: ResourceKey;
  readonly versionId: string;
  readonly root: ResourceKey;
  readonly steps: readonly ReferencePathStep[];
}

export interface PendingTarget {
  readonly key: ResourceKey;
  readonly requestedVersionId: string | null;
  readonly root: ResourceKey;
  readonly steps: readonly ReferencePathStep[];
}

interface MutableStats {
  consideredEdges: number;
  missingTargets: number;
  alreadyPresentTargets: number;
  targetLimitHits: number;
  edgesOmitted: number;
  citationsOmitted: number;
  uncitedTargetsOmitted: number;
  staleSourceEdges: number;
  missingRoots: number;
  edgeReadTruncated: boolean;
  maxDepthReached: number;
}

export interface TraversalState {
  readonly options: ReferenceTraversalOptions;
  readonly allowedTypes: ReadonlySet<string>;
  readonly roots: readonly ResourceKey[];
  readonly scheduledRequests: Set<string>;
  readonly resolvedRequests: Set<string>;
  readonly targets: ReferenceTarget[];
  readonly citations: ReferencePathCitation[];
  readonly stats: MutableStats;
  frontier: FrontierNode[];
}

export function keyOf(value: ResourceKey): string {
  return `${value.resourceType}/${value.resourceId}`;
}

export function requestKey(value: ReferenceTargetRequest): string {
  return `${keyOf(value)}/_history/${value.versionId ?? "current"}`;
}

export function addCitation(
  state: TraversalState,
  citation: ReferencePathCitation
): boolean {
  if (state.citations.length < state.options.maxCitations) {
    state.citations.push(citation);
    return true;
  }
  state.stats.citationsOmitted += 1;
  return false;
}

export function initializeState(
  rawRoots: readonly ResourceKey[],
  rawOptions: ReferenceTraversalOptions
): TraversalState {
  const roots = z
    .array(resourceKeySchema)
    .min(1)
    .max(REFERENCE_TRAVERSAL_LIMITS.roots)
    .parse(rawRoots);
  const options = optionsSchema.parse(rawOptions);
  const rootByKey = new Map(roots.map((root) => [keyOf(root), root]));
  return {
    options,
    allowedTypes: new Set(options.allowedResourceTypes),
    roots: [...rootByKey.values()].sort((left, right) =>
      keyOf(left).localeCompare(keyOf(right))
    ),
    scheduledRequests: new Set(),
    resolvedRequests: new Set(),
    targets: [],
    citations: [],
    stats: {
      consideredEdges: 0,
      missingTargets: 0,
      alreadyPresentTargets: 0,
      targetLimitHits: 0,
      edgesOmitted: 0,
      citationsOmitted: 0,
      uncitedTargetsOmitted: 0,
      staleSourceEdges: 0,
      missingRoots: 0,
      edgeReadTruncated: false,
      maxDepthReached: 0
    },
    frontier: []
  };
}
