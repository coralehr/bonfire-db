import { describe, expect, test } from "bun:test";
import type {
  ReferenceEdge,
  ReferenceEdgePage,
  ReferenceGraphReader,
  ReferenceTarget,
  ReferenceTargetRequest
} from "./walk.js";
import { walkReferenceGraph } from "./walk.js";

const ids = {
  report: "11111111-1111-4111-8111-111111111111",
  observation: "22222222-2222-4222-8222-222222222222",
  specimen: "33333333-3333-4333-8333-333333333333",
  child: "44444444-4444-4444-8444-444444444444",
  missing: "55555555-5555-4555-8555-555555555555"
};

function edge(
  sourceResourceType: string,
  sourceResourceId: string,
  jsonPath: string,
  targetResourceType: string,
  targetResourceId: string
): ReferenceEdge {
  return {
    sourceResourceType,
    sourceResourceId,
    sourceVersionId: "1",
    jsonPath,
    targetResourceType,
    targetResourceId,
    targetVersionId: null
  };
}

class MemoryReader implements ReferenceGraphReader {
  constructor(
    readonly edges: readonly ReferenceEdge[],
    readonly targets: readonly ReferenceTarget[]
  ) {}

  async readEdges(
    sourceKeys: readonly string[],
    maxRows: number
  ): Promise<ReferenceEdgePage> {
    const matches = this.edges.filter((item) =>
      sourceKeys.includes(`${item.sourceResourceType}/${item.sourceResourceId}`)
    );
    return { edges: matches.slice(0, maxRows), truncated: matches.length > maxRows };
  }

  async resolveTargets(requests: readonly ReferenceTargetRequest[]): Promise<readonly ReferenceTarget[]> {
    const resolved: ReferenceTarget[] = [];
    for (const request of requests) {
      const candidates = this.targets.filter(
        (item) =>
          request.resourceType === item.resourceType &&
          request.resourceId === item.resourceId
      );
      const match =
        request.versionId === null
          ? [...candidates].sort((left, right) =>
              Number(right.versionId) - Number(left.versionId)
            )[0]
          : candidates.find((item) => item.versionId === request.versionId);
      if (match !== undefined) resolved.push(match);
    }
    return resolved;
  }
}

describe("bounded reference graph walk", () => {
  test("returns deterministic path citations, missing targets, and depth-2 evidence", async () => {
    const reader = new MemoryReader(
      [
        edge(
          "DiagnosticReport",
          ids.report,
          "/result/0/reference",
          "Observation",
          ids.observation
        ),
        edge(
          "DiagnosticReport",
          ids.report,
          "/specimen/0/reference",
          "Specimen",
          ids.missing
        ),
        {
          ...edge(
            "Observation",
            ids.observation,
            "/hasMember/0/reference",
            "Observation",
            ids.child
          ),
          sourceVersionId: "3"
        },
        edge(
          "Observation",
          ids.child,
          "/hasMember/0/reference",
          "Observation",
          ids.observation
        )
      ],
      [
        {
          resourceType: "DiagnosticReport",
          resourceId: ids.report,
          versionId: "1",
          lastUpdated: "2026-07-13T00:00:00.000Z",
          content: { resourceType: "DiagnosticReport", id: ids.report }
        },
        {
          resourceType: "Observation",
          resourceId: ids.observation,
          versionId: "3",
          lastUpdated: "2026-07-13T00:00:00.000Z",
          content: { resourceType: "Observation", id: ids.observation }
        },
        {
          resourceType: "Observation",
          resourceId: ids.child,
          versionId: "2",
          lastUpdated: "2026-07-13T00:00:00.000Z",
          content: { resourceType: "Observation", id: ids.child }
        }
      ]
    );

    const result = await walkReferenceGraph(
      [{ resourceType: "DiagnosticReport", resourceId: ids.report }],
      reader,
      {
        profile: "micro-evidence-v1",
        allowedResourceTypes: ["DiagnosticReport", "Observation", "Specimen"],
        maxDepth: 2,
        maxTargets: 8,
        maxEdges: 12,
        maxCitations: 12
      }
    );

    expect(result.targets.map((target) => target.resourceId)).toEqual([
      ids.observation,
      ids.child
    ]);
    expect(result.stats).toEqual({
      consideredEdges: 3,
      fetchedTargets: 2,
      missingTargets: 1,
      alreadyPresentTargets: 0,
      targetLimitHits: 0,
      edgesOmitted: 0,
      citationsOmitted: 0,
      uncitedTargetsOmitted: 0,
      staleSourceEdges: 0,
      missingRoots: 0,
      edgeReadTruncated: false,
      maxDepthReached: 2
    });
    expect(result.citations.map((citation) => citation.status)).toEqual([
      "fetched",
      "missing",
      "fetched"
    ]);
    expect(result.citations[2]?.steps).toHaveLength(2);
    expect(result.citations[2]?.root).toEqual({
      resourceType: "DiagnosticReport",
      resourceId: ids.report
    });
  });

  test("enforces target and citation bounds without changing traversal order", async () => {
    const reader = new MemoryReader(
      [
        edge(
          "DiagnosticReport",
          ids.report,
          "/result/0/reference",
          "Observation",
          ids.observation
        ),
        edge(
          "DiagnosticReport",
          ids.report,
          "/specimen/0/reference",
          "Specimen",
          ids.specimen
        )
      ],
      [
        {
          resourceType: "DiagnosticReport",
          resourceId: ids.report,
          versionId: "1",
          lastUpdated: "2026-07-13T00:00:00.000Z",
          content: { resourceType: "DiagnosticReport", id: ids.report }
        },
        {
          resourceType: "Observation",
          resourceId: ids.observation,
          versionId: "1",
          lastUpdated: "2026-07-13T00:00:00.000Z",
          content: { resourceType: "Observation", id: ids.observation }
        },
        {
          resourceType: "Specimen",
          resourceId: ids.specimen,
          versionId: "1",
          lastUpdated: "2026-07-13T00:00:00.000Z",
          content: { resourceType: "Specimen", id: ids.specimen }
        }
      ]
    );

    const result = await walkReferenceGraph(
      [{ resourceType: "DiagnosticReport", resourceId: ids.report }],
      reader,
      {
        profile: "micro-evidence-v1",
        allowedResourceTypes: ["DiagnosticReport", "Observation", "Specimen"],
        maxDepth: 1,
        maxTargets: 1,
        maxEdges: 2,
        maxCitations: 1
      }
    );

    expect(result.targets).toHaveLength(0);
    expect(result.citations).toHaveLength(1);
    expect(result.stats.targetLimitHits).toBe(1);
    expect(result.stats.citationsOmitted).toBe(1);
    expect(result.stats.uncitedTargetsOmitted).toBe(1);
    expect(result.citations[0]?.status).toBe("target-limit");
  });

  test("omits evidence rather than returning a target without a fetched citation", async () => {
    const reader = new MemoryReader(
      [
        edge(
          "DiagnosticReport",
          ids.report,
          "/result/0/reference",
          "Observation",
          ids.missing
        ),
        edge(
          "DiagnosticReport",
          ids.report,
          "/specimen/0/reference",
          "Specimen",
          ids.specimen
        )
      ],
      [
        {
          resourceType: "DiagnosticReport",
          resourceId: ids.report,
          versionId: "1",
          lastUpdated: "2026-07-13T00:00:00.000Z",
          content: { resourceType: "DiagnosticReport", id: ids.report }
        },
        {
          resourceType: "Specimen",
          resourceId: ids.specimen,
          versionId: "1",
          lastUpdated: "2026-07-13T00:00:00.000Z",
          content: { resourceType: "Specimen", id: ids.specimen }
        }
      ]
    );

    const result = await walkReferenceGraph(
      [{ resourceType: "DiagnosticReport", resourceId: ids.report }],
      reader,
      {
        profile: "micro-evidence-v1",
        allowedResourceTypes: ["Observation", "Specimen"],
        maxDepth: 1,
        maxTargets: 4,
        maxEdges: 4,
        maxCitations: 1
      }
    );

    expect(result.citations.map((citation) => citation.status)).toEqual(["missing"]);
    expect(result.targets).toEqual([]);
    expect(result.stats.uncitedTargetsOmitted).toBe(1);
  });

  test("fails closed on stale source edges and does not conflate missing duplicates", async () => {
    const stale = {
      ...edge(
        "DiagnosticReport",
        ids.report,
        "/result/2/reference",
        "Observation",
        ids.child
      ),
      sourceVersionId: "1"
    };
    const missingA = {
      ...edge(
        "DiagnosticReport",
        ids.report,
        "/result/0/reference",
        "Observation",
        ids.missing
      ),
      sourceVersionId: "2"
    };
    const missingB = { ...missingA, jsonPath: "/result/1/reference" };
    const reader = new MemoryReader([stale, missingA, missingB], [
      {
        resourceType: "DiagnosticReport",
        resourceId: ids.report,
        versionId: "2",
        lastUpdated: "2026-07-13T00:00:00.000Z",
        content: { resourceType: "DiagnosticReport", id: ids.report }
      },
      {
        resourceType: "Observation",
        resourceId: ids.child,
        versionId: "1",
        lastUpdated: "2026-07-13T00:00:00.000Z",
        content: { resourceType: "Observation", id: ids.child }
      }
    ]);

    const result = await walkReferenceGraph(
      [{ resourceType: "DiagnosticReport", resourceId: ids.report }],
      reader,
      {
        profile: "clinical-reference-v1",
        allowedResourceTypes: ["Observation"],
        maxDepth: 1,
        maxTargets: 4,
        maxEdges: 4,
        maxCitations: 4
      }
    );

    expect(result.targets).toEqual([]);
    expect(result.citations.map((citation) => citation.status)).toEqual([
      "missing",
      "missing"
    ]);
    expect(result.stats.staleSourceEdges).toBe(1);
  });

  test("treats current and exact historical versions as distinct terminal requests", async () => {
    const current = edge(
      "DiagnosticReport",
      ids.report,
      "/result/0/reference",
      "Observation",
      ids.observation
    );
    const historicalOne = {
      ...current,
      jsonPath: "/result/1/reference",
      targetVersionId: "1"
    };
    const historicalTwo = {
      ...current,
      jsonPath: "/result/2/reference",
      targetVersionId: "2"
    };
    const targets: ReferenceTarget[] = [
      {
        resourceType: "DiagnosticReport",
        resourceId: ids.report,
        versionId: "1",
        lastUpdated: "2026-07-13T00:00:00.000Z",
        content: { resourceType: "DiagnosticReport", id: ids.report }
      },
      ...["1", "2", "3"].map((versionId) => ({
        resourceType: "Observation",
        resourceId: ids.observation,
        versionId,
        lastUpdated: "2026-07-13T00:00:00.000Z",
        content: { resourceType: "Observation", id: ids.observation }
      }))
    ];
    const result = await walkReferenceGraph(
      [{ resourceType: "DiagnosticReport", resourceId: ids.report }],
      new MemoryReader([current, historicalOne, historicalTwo], targets),
      {
        profile: "micro-evidence-v1",
        allowedResourceTypes: ["Observation"],
        maxDepth: 2,
        maxTargets: 4,
        maxEdges: 4,
        maxCitations: 4
      }
    );

    expect(result.targets.map((target) => target.versionId)).toEqual(["3", "1", "2"]);
    expect(result.citations.map((citation) => citation.status)).toEqual([
      "fetched",
      "fetched",
      "fetched"
    ]);
    expect(result.stats.maxDepthReached).toBe(2);
  });

  test("charges filtered rows against the global storage-read edge bound", async () => {
    const reader = new MemoryReader(
      [
        edge(
          "DiagnosticReport",
          ids.report,
          "/result/0/reference",
          "Observation",
          ids.observation
        ),
        edge(
          "DiagnosticReport",
          ids.report,
          "/subject/reference",
          "Patient",
          ids.missing
        ),
        {
          ...edge(
            "Observation",
            ids.observation,
            "/hasMember/0/reference",
            "Observation",
            ids.child
          ),
          sourceVersionId: "3"
        }
      ],
      [
        {
          resourceType: "DiagnosticReport",
          resourceId: ids.report,
          versionId: "1",
          lastUpdated: "2026-07-13T00:00:00.000Z",
          content: { resourceType: "DiagnosticReport", id: ids.report }
        },
        {
          resourceType: "Observation",
          resourceId: ids.observation,
          versionId: "3",
          lastUpdated: "2026-07-13T00:00:00.000Z",
          content: { resourceType: "Observation", id: ids.observation }
        },
        {
          resourceType: "Observation",
          resourceId: ids.child,
          versionId: "1",
          lastUpdated: "2026-07-13T00:00:00.000Z",
          content: { resourceType: "Observation", id: ids.child }
        }
      ]
    );

    const result = await walkReferenceGraph(
      [{ resourceType: "DiagnosticReport", resourceId: ids.report }],
      reader,
      {
        profile: "micro-evidence-v1",
        allowedResourceTypes: ["Observation", "Patient"],
        maxDepth: 2,
        maxTargets: 4,
        maxEdges: 2,
        maxCitations: 4
      }
    );

    expect(result.stats.consideredEdges).toBe(2);
    expect(result.stats.maxDepthReached).toBe(1);
    expect(result.targets.map((target) => target.resourceId)).toEqual([ids.observation]);
  });
});
