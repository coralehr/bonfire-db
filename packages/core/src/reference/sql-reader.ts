/** Tenant-RLS SQL adapter for the pure bounded reference walker. */
import { z } from "zod";
import { fhirContentSchema } from "../db/fhir-store.js";
import type { TenantSql } from "../db/tenant.js";
import {
  REFERENCE_TRAVERSAL_LIMITS,
  type ReferenceEdgePage,
  type ReferenceGraphReader,
  type ReferenceTarget,
  type ReferenceTargetRequest
} from "./walk.js";

const edgeRowSchema = z.object({
  source_resource_type: z.string().min(1),
  source_resource_id: z.string().min(1),
  source_version_id: z.string().min(1),
  json_path: z.string().min(1),
  target_resource_type: z.string().min(1),
  target_resource_id: z.string().min(1),
  target_version_id: z.string().nullable()
});
const targetRowSchema = z.object({
  resource_type: z.string().min(1),
  resource_id: z.string().min(1),
  version_id: z.string().min(1),
  last_updated: z.string().min(1),
  content: fhirContentSchema
});

function requestKey(request: ReferenceTargetRequest): string {
  return `${request.resourceType}/${request.resourceId}/${request.versionId ?? ""}`;
}

export function parseReferenceTargets(rows: readonly unknown[]): readonly ReferenceTarget[] {
  return rows.map((row) => {
    const parsed = targetRowSchema.parse(row);
    if (
      parsed.content.resourceType !== parsed.resource_type ||
      parsed.content.id !== parsed.resource_id
    ) {
      throw new Error("resolved target content identity does not match its canonical row");
    }
    return {
      resourceType: parsed.resource_type,
      resourceId: parsed.resource_id,
      versionId: parsed.version_id,
      lastUpdated: parsed.last_updated,
      content: parsed.content
    };
  });
}

async function readEdgesTx(
  sql: TenantSql,
  sourceKeys: readonly string[],
  maxRows: number
): Promise<ReferenceEdgePage> {
  const bound = z.number().int().min(1).max(REFERENCE_TRAVERSAL_LIMITS.edges).parse(maxRows);
  if (sourceKeys.length === 0) return { edges: [], truncated: false };
  const rows = await sql`
    select source_resource_type, source_resource_id::text as source_resource_id,
      source_version_id::text as source_version_id, json_path,
      target_resource_type, target_resource_id, target_version_id
    from fhir_reference_edges
    where (source_resource_type || '/' || source_resource_id::text) = any(${[...sourceKeys]})
    order by source_resource_type, source_resource_id, json_path,
      target_resource_type, target_resource_id
    limit ${bound + 1}`;
  const truncated = rows.length > bound;
  const edges = rows.slice(0, bound).map((row) => {
    const parsed = edgeRowSchema.parse(row);
    return {
      sourceResourceType: parsed.source_resource_type,
      sourceResourceId: parsed.source_resource_id,
      sourceVersionId: parsed.source_version_id,
      jsonPath: parsed.json_path,
      targetResourceType: parsed.target_resource_type,
      targetResourceId: parsed.target_resource_id,
      targetVersionId: parsed.target_version_id
    };
  });
  return { edges, truncated };
}

async function resolveTargetsTx(
  sql: TenantSql,
  requests: readonly ReferenceTargetRequest[]
): Promise<readonly ReferenceTarget[]> {
  if (requests.length === 0) return [];
  const currentKeys = requests
    .filter((request) => request.versionId === null)
    .map((request) => `${request.resourceType}/${request.resourceId}`);
  const historyKeys = requests.filter((request) => request.versionId !== null).map(requestKey);
  const current =
    currentKeys.length === 0
      ? []
      : await sql`
          select type as resource_type, id::text as resource_id,
            version_id::text as version_id, last_updated::text as last_updated, content
          from fhir_resources
          where (type || '/' || id::text) = any(${currentKeys})`;
  const history =
    historyKeys.length === 0
      ? []
      : await sql`
          select type as resource_type, id::text as resource_id,
            version_id::text as version_id, last_updated::text as last_updated, content
          from history
          where (type || '/' || id::text || '/' || version_id::text) = any(${historyKeys})`;
  return [...parseReferenceTargets(current), ...parseReferenceTargets(history)].sort(
    (left, right) =>
      `${left.resourceType}/${left.resourceId}/${left.versionId}`.localeCompare(
        `${right.resourceType}/${right.resourceId}/${right.versionId}`
      )
  );
}

export function createReferenceGraphReader(sql: TenantSql): ReferenceGraphReader {
  return {
    readEdges: (sourceKeys, maxRows) => readEdgesTx(sql, sourceKeys, maxRows),
    resolveTargets: (requests) => resolveTargetsTx(sql, requests)
  };
}
