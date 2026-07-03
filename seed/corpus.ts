/**
 * Corpus loading, per-practice UUIDv5 re-iding, intra-corpus reference
 * rewriting, and tenant-scoped inserts.
 *
 * Inserts run inside withTenant as bonfire_app, so every row is a standing
 * RLS WITH CHECK proof. ON CONFLICT (id) DO NOTHING is the drift backstop:
 * when the latest row already exists the history/write_inputs rows are
 * skipped too, keeping the three tables in lockstep under append-only grants.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject, JsonValue, TenantSql } from "@bonfire/core";
import { contentHash, jsonValueSchema } from "@bonfire/core";
import { z } from "zod";
import type { CorpusManifest } from "./manifest.js";
import { normalizeLf } from "./manifest.js";
import { uuidv5 } from "./uuidv5.js";

const corpusLineSchema = z.record(z.string(), jsonValueSchema);

export interface CorpusResource {
  /** Source-relative reference target, e.g. "Patient/patient-1". */
  readonly sourceRef: string;
  readonly resourceType: string;
  readonly content: JsonObject;
}

export interface ReIdedResource {
  readonly id: string;
  readonly type: string;
  readonly content: JsonObject;
  readonly rawPayload: string;
}

function parseCorpusLine(line: string, path: string, expectedType: string): CorpusResource {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    // Never echo fixture content into logs on a parse failure — location only.
    throw new Error(`invalid JSON in ${path} (content not shown)`);
  }
  const content = corpusLineSchema.parse(raw);
  const resourceType = content.resourceType;
  const id = content.id;
  if (typeof resourceType !== "string" || typeof id !== "string") {
    throw new Error(`corpus line in ${path} lacks string resourceType/id`);
  }
  if (resourceType !== expectedType) {
    throw new Error(`corpus line in ${path} is ${resourceType}, manifest says ${expectedType}`);
  }
  return { sourceRef: `${resourceType}/${id}`, resourceType, content };
}

/** Load every manifest file as parsed, type-checked corpus resources. */
export function loadCorpus(fixturesDir: string, manifest: CorpusManifest): CorpusResource[] {
  const resources: CorpusResource[] = [];
  for (const file of manifest.files) {
    const text = normalizeLf(readFileSync(join(fixturesDir, file.path), "utf8"));
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      resources.push(parseCorpusLine(line, file.path, file.resourceType));
    }
  }
  return resources;
}

function rewriteRefs(value: JsonValue, refMap: ReadonlyMap<string, string>): JsonValue {
  if (typeof value === "string") return refMap.get(value) ?? value;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => rewriteRefs(item, refMap));
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value)) {
    const child = value[key];
    if (child !== undefined) result[key] = rewriteRefs(child, refMap);
  }
  return result;
}

/**
 * Mirror the SAME corpus into one practice: deterministic UUIDv5 ids namespaced
 * by the practice, with every intra-corpus reference rewritten to match.
 */
export function reIdForPractice(
  practiceId: string,
  resources: readonly CorpusResource[]
): ReIdedResource[] {
  const refMap = new Map<string, string>();
  const idMap = new Map<string, string>();
  for (const resource of resources) {
    const newId = uuidv5(practiceId, resource.sourceRef);
    idMap.set(resource.sourceRef, newId);
    refMap.set(resource.sourceRef, `${resource.resourceType}/${newId}`);
  }
  return resources.map((resource) => {
    const id = idMap.get(resource.sourceRef);
    if (id === undefined) throw new Error(`unmapped corpus ref ${resource.sourceRef}`);
    const rewritten = rewriteRefs(resource.content, refMap);
    if (typeof rewritten !== "object" || rewritten === null || Array.isArray(rewritten)) {
      throw new Error(`corpus resource ${resource.sourceRef} is not a JSON object`);
    }
    const content: JsonObject = { ...rewritten, id };
    return { id, type: resource.resourceType, content, rawPayload: JSON.stringify(content) };
  });
}

export interface InsertCounts {
  readonly inserted: number;
  readonly skipped: number;
}

/**
 * Insert re-ided resources through the three-table shape under the caller's
 * tenant transaction. Returns how many were inserted vs conflict-skipped.
 */
export async function insertCorpusResources(
  sql: TenantSql,
  practiceId: string,
  resources: readonly ReIdedResource[]
): Promise<InsertCounts> {
  let inserted = 0;
  let skipped = 0;
  for (const resource of resources) {
    const rows = await sql`
      insert into fhir_resources (id, type, practice_id, version_id, last_updated, content)
      values (${resource.id}, ${resource.type}, ${practiceId}, 1, now(),
        ${sql.json(resource.content)})
      on conflict (id) do nothing
      returning id`;
    if (rows.length === 0) {
      skipped += 1;
      continue;
    }
    const hash = contentHash(resource.content);
    await sql`
      insert into history (id, version_id, type, practice_id, content, content_hash, last_updated)
      values (${resource.id}, 1, ${resource.type}, ${practiceId},
        ${sql.json(resource.content)}, ${hash}, now())`;
    await sql`
      insert into write_inputs (practice_id, fhir_resource_id, raw_payload)
      values (${practiceId}, ${resource.id}, ${resource.rawPayload})`;
    inserted += 1;
  }
  return { inserted, skipped };
}
