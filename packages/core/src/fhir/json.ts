/**
 * Bridge from typed FHIR resource shapes (fhir4.*) to the canonical `JsonObject`
 * the write path persists: serialize to pure JSON then re-parse THROUGH Zod, so
 * the hashed source of truth is a proven `JsonObject`, never an `any` cast.
 */
import { z } from "zod";
import type { JsonObject, JsonValue } from "../db/canonical-json.js";
import { jsonValueSchema } from "../db/fhir-store.js";

const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

/** Serialize a JSON-native value to a validated JsonObject (throws if not an object). */
export function toJsonObject(value: unknown): JsonObject {
  const roundTripped: unknown = JSON.parse(JSON.stringify(value));
  const parsed = jsonObjectSchema.safeParse(roundTripped);
  if (!parsed.success) {
    throw new TypeError("value did not serialize to a JSON object");
  }
  return parsed.data;
}

/** Parse a JSON string into a validated JsonValue (throws on malformed input). */
export function parseJsonValue(text: string): JsonValue {
  const parsed: unknown = JSON.parse(text);
  const result = jsonValueSchema.safeParse(parsed);
  if (!result.success) {
    throw new TypeError("text did not parse to a JSON value");
  }
  return result.data;
}
