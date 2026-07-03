/**
 * RFC 8785 (JCS) canonicalizer + contentHash behavior.
 *
 * Inversion-proof by construction: the literal expected strings fail if key
 * sorting, number normalization, or the volatile-meta exclusion is removed.
 */
import { describe, expect, test } from "bun:test";
import { canonicalizeJson, contentHash } from "./canonical-json.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

describe("canonicalizeJson (RFC 8785)", () => {
  test("object keys are sorted by UTF-16 code units", () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    // "z" (U+007A) sorts BEFORE "é" (U+00E9) — code units, not locale order.
    expect(canonicalizeJson({ é: 1, z: 2 })).toBe('{"z":2,"é":1}');
  });

  test("nested objects are sorted; array order is preserved", () => {
    const value = { z: [{ b: 1, a: null }, true], "1": false };
    expect(canonicalizeJson(value)).toBe('{"1":false,"z":[{"a":null,"b":1},true]}');
  });

  test("literals and strings serialize like JSON.stringify", () => {
    expect(canonicalizeJson({ literals: [null, true, false] })).toBe(
      '{"literals":[null,true,false]}'
    );
    expect(canonicalizeJson("a\nb")).toBe('"a\\nb"');
  });

  test("numbers use ECMAScript shortest-round-trip form (1.50 -> 1.5)", () => {
    expect(canonicalizeJson(JSON.parse('{"v":1.50,"w":10,"x":0.5}'))).toBe(
      '{"v":1.5,"w":10,"x":0.5}'
    );
  });

  test("non-finite numbers throw (programmer error, not representable)", () => {
    expect(() => canonicalizeJson(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalizeJson(Number.NaN)).toThrow(TypeError);
  });
});

describe("contentHash", () => {
  const resource = {
    resourceType: "Patient",
    id: "example-1",
    name: [{ family: "Fixture101", given: ["Case202"] }]
  };

  test("is a 64-char sha256 hex string", () => {
    expect(contentHash(resource)).toMatch(SHA256_HEX);
  });

  test("is stable under key reordering (canonical form, not input order)", () => {
    const reordered = {
      name: [{ given: ["Case202"], family: "Fixture101" }],
      id: "example-1",
      resourceType: "Patient"
    };
    expect(contentHash(reordered)).toBe(contentHash(resource));
  });

  test("excludes meta.versionId and meta.lastUpdated from the hash", () => {
    const withVolatileMeta = {
      ...resource,
      meta: { versionId: "9", lastUpdated: "2026-07-03T00:00:00Z" }
    };
    expect(contentHash(withVolatileMeta)).toBe(contentHash(resource));
  });

  test("keeps non-volatile meta fields in the hash", () => {
    const withProfile = { ...resource, meta: { profile: ["synthetic-profile"] } };
    expect(contentHash(withProfile)).not.toBe(contentHash(resource));
  });

  test("changes when clinical content changes", () => {
    const changed = { ...resource, name: [{ family: "Other303", given: ["Case202"] }] };
    expect(contentHash(changed)).not.toBe(contentHash(resource));
  });
});
