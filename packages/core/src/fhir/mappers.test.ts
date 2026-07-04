/**
 * Mapper unit behavior: toFhir stamps the US Core profile (and stamps NONE for
 * base-R4 Consent), fromFhir rejects non-scribe content, collectCodings finds
 * coded fields, and the JSON bridge round-trips through Zod.
 */
import { describe, expect, test } from "bun:test";
import {
  collectCodings,
  fromFhir,
  parseJsonValue,
  type ScribeInput,
  toFhir,
  toJsonObject,
  US_CORE_PROFILES
} from "../index.js";

const patient: ScribeInput = {
  resourceType: "Patient",
  id: "11111111-1111-4111-8111-111111111111",
  identifier: [{ system: "http://myhospital.org/mrn", value: "MRN-1" }],
  name: [{ family: "Roundtrip" }],
  gender: "female"
};

const consent: ScribeInput = {
  resourceType: "Consent",
  id: "99999999-9999-4999-8999-999999999999",
  status: "active",
  scope: {
    coding: [
      { system: "http://terminology.hl7.org/CodeSystem/consentscope", code: "patient-privacy" }
    ]
  },
  category: [{ coding: [{ system: "http://loinc.org", code: "59284-0" }] }],
  patient: { reference: "Patient/11111111-1111-4111-8111-111111111111" },
  dateTime: "2024-01-01T00:00:00Z",
  policyRule: {
    coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ActCode", code: "OPTIN" }]
  }
};

describe("toFhir stamps the correct profile", () => {
  test("Patient carries its US Core profile", () => {
    const fhir = toFhir(patient);
    expect(fhir.meta).toEqual({ profile: US_CORE_PROFILES.Patient });
    expect(fhir.resourceType).toBe("Patient");
  });

  test("Consent carries NO profile (base R4 — US Core 6.1.0 has none)", () => {
    expect(US_CORE_PROFILES.Consent).toBeNull();
    expect(toFhir(consent).meta).toBeUndefined();
  });
});

describe("fromFhir default-denies non-scribe content", () => {
  test("an unknown resourceType is UNMAPPABLE_FHIR", () => {
    const result = fromFhir({ resourceType: "Bundle", id: "x" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNMAPPABLE_FHIR");
  });

  test("stripping meta then re-validating recovers the input", () => {
    const recovered = fromFhir(toFhir(patient));
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.data).toEqual(patient);
  });
});

describe("coding + JSON helpers", () => {
  test("collectCodings finds each coding with a pointer", () => {
    const codings = collectCodings(toFhir(consent));
    const systems = codings.map((c) => c.system);
    expect(systems).toContain("http://terminology.hl7.org/CodeSystem/consentscope");
    expect(systems).toContain("http://loinc.org");
    expect(codings.every((c) => c.pointer.startsWith("/"))).toBe(true);
  });

  test("toJsonObject rejects a non-object and parseJsonValue rejects garbage", () => {
    expect(() => toJsonObject(42)).toThrow();
    expect(() => parseJsonValue("{not json")).toThrow();
    expect(toJsonObject(parseJsonValue('{"a":1}'))).toEqual({ a: 1 });
  });
});
