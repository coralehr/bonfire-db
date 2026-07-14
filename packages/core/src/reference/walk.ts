import { isAllowedReferenceEdge } from "./semantic-catalog.js";
import {
  addCitation,
  type FrontierNode,
  initializeState,
  keyOf,
  type PendingTarget,
  requestKey,
  type TraversalState
} from "./walk-state.js";
import {
  type ReferenceEdge,
  type ReferenceGraphReader,
  type ReferenceTarget,
  type ReferenceTargetRequest,
  type ReferenceTraversalOptions,
  type ReferenceTraversalResult,
  type ResourceKey
} from "./walk-types.js";

export { REFERENCE_TRAVERSAL_LIMITS } from "./walk-types.js";
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
} from "./walk-types.js";

function edgeKey(edge: ReferenceEdge): string {
  return [
    edge.sourceResourceType,
    edge.sourceResourceId,
    edge.jsonPath,
    edge.targetResourceType,
    edge.targetResourceId
  ].join("\u0000");
}

async function boundedEdges(
  state: TraversalState,
  reader: ReferenceGraphReader
): Promise<readonly [ReadonlyMap<string, FrontierNode>, readonly ReferenceEdge[]]> {
  const frontier = new Map(state.frontier.map((node) => [keyOf(node.key), node]));
  const remaining = Math.max(0, state.options.maxEdges - state.stats.consideredEdges);
  if (remaining === 0) return [frontier, []];
  const page = await reader.readEdges([...frontier.keys()].sort(), remaining);
  const readEdges = page.edges.slice(0, remaining);
  state.stats.edgeReadTruncated ||= page.truncated || page.edges.length > remaining;
  state.stats.consideredEdges += readEdges.length;
  const eligible = [...readEdges]
    .filter(
      (edge) => {
        const source = frontier.get(
          `${edge.sourceResourceType}/${edge.sourceResourceId}`
        );
        if (source === undefined) return false;
        if (edge.sourceVersionId !== source.versionId) {
          state.stats.staleSourceEdges += 1;
          return false;
        }
        return (
          state.allowedTypes.has(edge.targetResourceType) &&
          isAllowedReferenceEdge(state.options.profile, edge)
        );
      }
    )
    .sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
  state.stats.edgesOmitted += page.truncated || page.edges.length > remaining ? 1 : 0;
  return [frontier, eligible];
}

function collectPending(
  state: TraversalState,
  frontier: ReadonlyMap<string, FrontierNode>,
  edges: readonly ReferenceEdge[],
  depth: number
): PendingTarget[] {
  const pending: PendingTarget[] = [];
  for (const edge of edges) {
    const source = frontier.get(`${edge.sourceResourceType}/${edge.sourceResourceId}`);
    if (source === undefined) continue;
    const target = { resourceType: edge.targetResourceType, resourceId: edge.targetResourceId };
    const steps = [
      ...source.steps,
      {
        source: source.key,
        sourceVersionId: edge.sourceVersionId,
        jsonPath: edge.jsonPath,
        target,
        targetVersionId: edge.targetVersionId
      }
    ];
    const requestedVersionId = edge.targetVersionId;
    const targetRequestKey = requestKey({ ...target, versionId: requestedVersionId });
    if (state.resolvedRequests.has(targetRequestKey)) {
      state.stats.alreadyPresentTargets += 1;
      addCitation(state, { root: source.root, depth, steps, status: "already-present" });
    } else if (
      !state.scheduledRequests.has(targetRequestKey) &&
      state.scheduledRequests.size >= state.options.maxTargets
    ) {
      state.stats.targetLimitHits += 1;
      addCitation(state, { root: source.root, depth, steps, status: "target-limit" });
    } else {
      state.scheduledRequests.add(targetRequestKey);
      pending.push({ key: target, requestedVersionId, root: source.root, steps });
    }
  }
  return pending;
}

function targetRequests(
  pending: readonly PendingTarget[],
  historical: boolean
): ReferenceTargetRequest[] {
  const unique = new Map(
    pending
    .filter((item) => (item.requestedVersionId !== null) === historical)
    .map((item) => {
      const request = { ...item.key, versionId: item.requestedVersionId };
      return [requestKey(request), request] as const;
    })
  );
  return [...unique.values()]
    .sort((left, right) =>
      `${keyOf(left)}/${left.versionId ?? ""}`.localeCompare(
        `${keyOf(right)}/${right.versionId ?? ""}`
      )
    );
}

function acceptResolvedTarget(
  state: TraversalState,
  item: PendingTarget,
  target: ReferenceTarget | undefined,
  depth: number,
  itemRequestKey: string,
  nextFrontier: FrontierNode[]
): void {
  if (target === undefined) {
    state.stats.missingTargets += 1;
    addCitation(state, { root: item.root, depth, steps: item.steps, status: "missing" });
    return;
  }
  if (state.resolvedRequests.has(itemRequestKey)) {
    state.stats.alreadyPresentTargets += 1;
    addCitation(state, {
      root: item.root,
      depth,
      steps: item.steps,
      status: "already-present"
    });
    return;
  }
  const cited = addCitation(state, {
    root: item.root,
    depth,
    steps: item.steps,
    status: "fetched"
  });
  if (!cited) {
    state.stats.uncitedTargetsOmitted += 1;
    return;
  }
  state.resolvedRequests.add(itemRequestKey);
  state.targets.push(target);
  if (item.requestedVersionId === null) {
    nextFrontier.push({
      key: target,
      versionId: target.versionId,
      root: item.root,
      steps: item.steps
    });
  }
}

async function resolvePending(
  state: TraversalState,
  reader: ReferenceGraphReader,
  pending: readonly PendingTarget[],
  depth: number
): Promise<void> {
  const [current, historical] = await Promise.all([
    reader.resolveTargets(targetRequests(pending, false)),
    reader.resolveTargets(targetRequests(pending, true))
  ]);
  const currentByKey = new Map(current.map((target) => [keyOf(target), target]));
  const historyByKey = new Map(
    historical.map((target) => [`${keyOf(target)}/${target.versionId}`, target])
  );
  const nextFrontier: FrontierNode[] = [];
  for (const item of pending) {
    const itemRequestKey = requestKey({
      ...item.key,
      versionId: item.requestedVersionId
    });
    const target =
      item.requestedVersionId === null
        ? currentByKey.get(keyOf(item.key))
        : historyByKey.get(`${keyOf(item.key)}/${item.requestedVersionId}`);
    acceptResolvedTarget(state, item, target, depth, itemRequestKey, nextFrontier);
  }
  state.frontier = nextFrontier;
}

async function resolveRoots(
  state: TraversalState,
  reader: ReferenceGraphReader
): Promise<void> {
  const requests = state.roots.map((root) => ({ ...root, versionId: null }));
  const resolved = await reader.resolveTargets(requests);
  const byKey = new Map(resolved.map((target) => [keyOf(target), target]));
  state.frontier = state.roots.flatMap((root) => {
    const target = byKey.get(keyOf(root));
    if (target === undefined) {
      state.stats.missingRoots += 1;
      return [];
    }
    return [{ key: root, versionId: target.versionId, root, steps: [] }];
  });
}

export async function walkReferenceGraph(
  rawRoots: readonly ResourceKey[],
  reader: ReferenceGraphReader,
  rawOptions: ReferenceTraversalOptions
): Promise<ReferenceTraversalResult> {
  const state = initializeState(rawRoots, rawOptions);
  await resolveRoots(state, reader);
  for (
    let depth = 1;
    depth <= state.options.maxDepth && state.frontier.length > 0;
    depth += 1
  ) {
    state.stats.maxDepthReached = depth;
    const [frontier, edges] = await boundedEdges(state, reader);
    await resolvePending(state, reader, collectPending(state, frontier, edges, depth), depth);
    if (state.stats.consideredEdges >= state.options.maxEdges) break;
  }
  return {
    profile: state.options.profile,
    targets: state.targets,
    citations: state.citations,
    stats: {
      ...state.stats,
      fetchedTargets: state.targets.length
    }
  };
}
