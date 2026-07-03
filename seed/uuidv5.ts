/**
 * RFC 4122 UUIDv5 (name-based, SHA-1) via node:crypto — no dependency.
 * Deterministic ids are the seed's idempotency backstop: the same
 * (practice namespace, source ref) always derives the same id, so a re-run
 * can only ever collide with itself.
 */
import { createHash } from "node:crypto";

const UUID_BYTE_LENGTH = 16;
const VERSION_BYTE_INDEX = 6;
const VARIANT_BYTE_INDEX = 8;
const VERSION_NIBBLE_MASK = 0x0f;
const VERSION_5_BITS = 0x50;
const VARIANT_BITS_MASK = 0x3f;
const VARIANT_RFC4122_BITS = 0x80;
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_GROUPS = /^(.{8})(.{4})(.{4})(.{4})(.{12})$/;

/** Derive the UUIDv5 of `name` under the `namespace` UUID. */
export function uuidv5(namespace: string, name: string): string {
  if (!UUID_TEXT.test(namespace)) {
    throw new Error("uuidv5 namespace must be a UUID");
  }
  const namespaceBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const digest = createHash("sha1").update(namespaceBytes).update(name, "utf8").digest();
  const bytes = digest.subarray(0, UUID_BYTE_LENGTH);
  const versionByte = bytes[VERSION_BYTE_INDEX];
  const variantByte = bytes[VARIANT_BYTE_INDEX];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error("sha1 digest unexpectedly short");
  }
  bytes[VERSION_BYTE_INDEX] = (versionByte & VERSION_NIBBLE_MASK) | VERSION_5_BITS;
  bytes[VARIANT_BYTE_INDEX] = (variantByte & VARIANT_BITS_MASK) | VARIANT_RFC4122_BITS;
  return bytes.toString("hex").replace(UUID_GROUPS, "$1-$2-$3-$4-$5");
}
