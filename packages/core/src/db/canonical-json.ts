/**
 * RFC 8785 (JCS) canonical JSON + content hashing, dependency-free.
 * Accepted BF-02 caveat: FHIR `decimal` precision is lossy under JCS number
 * serialization — every hashed value already passed through JSON.parse, so
 * write-time and readback hashes stay self-consistent; wire-byte
 * canonicalization belongs to BF-03.
 */
import { createHash } from "node:crypto";

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

function canonicalizeObject(value: JsonObject): string {
  const members = Object.keys(value)
    .sort()
    .map((key) => {
      const child = value[key];
      if (child === undefined) return undefined;
      return `${JSON.stringify(key)}:${canonicalizeJson(child)}`;
    })
    .filter((member): member is string => member !== undefined);
  return `{${members.join(",")}}`;
}

/** Serialize a JSON value to its RFC 8785 canonical form. */
export function canonicalizeJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON cannot represent a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  return canonicalizeObject(value);
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Drop meta.versionId and meta.lastUpdated before hashing; an emptied meta is
 * removed entirely so `{...}` and `{..., meta: {versionId}}` hash identically.
 */
function stripVolatileMeta(resource: JsonObject): JsonObject {
  const meta = resource.meta;
  if (!isJsonObject(meta)) return resource;
  const { versionId: _versionId, lastUpdated: _lastUpdated, ...keptMeta } = meta;
  if (Object.keys(keptMeta).length === 0) {
    const { meta: _meta, ...rest } = resource;
    return rest;
  }
  return { ...resource, meta: keptMeta };
}

/** SHA-256 hex over the canonical form, volatile meta fields excluded. */
export function contentHash(resource: JsonObject): string {
  const canonical = canonicalizeJson(stripVolatileMeta(resource));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
