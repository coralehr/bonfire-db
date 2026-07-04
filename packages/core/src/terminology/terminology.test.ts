/**
 * Terminology seam unit behavior (no DB, no network).
 *
 * - SNOMED is FORMAT-only (Verhoeff/partition), never membership — a valid SCTID
 *   passes, a corrupted one fails, and neither ever blocks a write.
 * - BundledPackValidator resolves purely from an injected lookup: a hit records
 *   the pack version, a miss returns result:false WITH the version (WARN, never
 *   throw), and an unloaded system returns result:false with no version.
 * - RemoteTxValidator is a deferred seam: it rejects with NotImplemented and
 *   holds no HTTP client, so validate-on-write can never make a network call.
 */
import { describe, expect, test } from "bun:test";
import type { TerminologyConceptLookup } from "../index.js";
import {
  createBundledPackValidator,
  createRemoteTxValidator,
  isSnomedSystem,
  isValidSctid,
  TerminologyNotImplementedError
} from "../index.js";

describe("SNOMED format-only validation", () => {
  test("well-formed SCTIDs pass, malformed ones fail (never a membership check)", () => {
    expect(isSnomedSystem("http://snomed.info/sct")).toBe(true);
    expect(isSnomedSystem("http://loinc.org")).toBe(false);
    expect(isValidSctid("73211009")).toBe(true);
    expect(isValidSctid("80146002")).toBe(true);
    expect(isValidSctid("73211008")).toBe(false); // bad Verhoeff check digit
    expect(isValidSctid("12")).toBe(false); // too short
    expect(isValidSctid("not-a-code")).toBe(false);
  });
});

const loadedLookup: TerminologyConceptLookup = {
  findConcept: (system, code) =>
    Promise.resolve(
      system === "http://hl7.org/fhir/sid/icd-10-cm" && code === "E11.9"
        ? { version: "2026" }
        : undefined
    ),
  packVersion: (system) =>
    Promise.resolve(system === "http://hl7.org/fhir/sid/icd-10-cm" ? "2026" : undefined)
};

describe("BundledPackValidator resolves from local packs only", () => {
  const validator = createBundledPackValidator(loadedLookup);

  test("a hit records the pack version", async () => {
    const result = await validator.validateCode({
      system: "http://hl7.org/fhir/sid/icd-10-cm",
      code: "E11.9"
    });
    expect(result).toEqual({ result: true, version: "2026" });
  });

  test("a miss in a loaded pack WARNs (result:false) with the version", async () => {
    const result = await validator.validateCode({
      system: "http://hl7.org/fhir/sid/icd-10-cm",
      code: "Z99.9"
    });
    expect(result.result).toBe(false);
    expect(result.version).toBe("2026");
  });

  test("an unloaded system returns result:false with no version", async () => {
    const result = await validator.validateCode({ system: "http://loinc.org", code: "718-7" });
    expect(result.result).toBe(false);
    expect(result.version).toBeUndefined();
  });
});

describe("RemoteTxValidator is a deferred, offline seam", () => {
  test("validateCode rejects with NotImplemented (no network client)", async () => {
    const remote = createRemoteTxValidator();
    await expect(
      remote.validateCode({ system: "http://snomed.info/sct", code: "73211009" })
    ).rejects.toBeInstanceOf(TerminologyNotImplementedError);
  });
});
