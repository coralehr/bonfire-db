import { describe, expect, test } from "bun:test";
import { extractExplicitReferences } from "./extract.js";

describe("explicit FHIR reference extraction", () => {
  test("extracts relative references with deterministic RFC 6901 paths", () => {
    const edges = extractExplicitReferences({
      resourceType: "DiagnosticReport",
      id: "11111111-1111-4111-8111-111111111111",
      subject: { reference: "Patient/22222222-2222-4222-8222-222222222222" },
      result: [
        { reference: "Observation/44444444-4444-4444-8444-444444444444" },
        { reference: "Observation/33333333-3333-4333-8333-333333333333" }
      ],
      specimen: [
        {
          reference:
            "Specimen/55555555-5555-4555-8555-555555555555/_history/7"
        }
      ],
      note: [{ text: "Observation/not-a-reference-field" }]
    });

    expect(edges).toEqual([
      {
        jsonPath: "/result/0/reference",
        targetResourceId: "44444444-4444-4444-8444-444444444444",
        targetResourceType: "Observation",
        targetVersionId: null
      },
      {
        jsonPath: "/result/1/reference",
        targetResourceId: "33333333-3333-4333-8333-333333333333",
        targetResourceType: "Observation",
        targetVersionId: null
      },
      {
        jsonPath: "/specimen/0/reference",
        targetResourceId: "55555555-5555-4555-8555-555555555555",
        targetResourceType: "Specimen",
        targetVersionId: "7"
      },
      {
        jsonPath: "/subject/reference",
        targetResourceId: "22222222-2222-4222-8222-222222222222",
        targetResourceType: "Patient",
        targetVersionId: null
      }
    ]);
  });

  test("ignores contained, absolute, URN, malformed, and non-reference values", () => {
    const edges = extractExplicitReferences({
      resourceType: "Observation",
      id: "11111111-1111-4111-8111-111111111111",
      contained: [{ id: "local" }],
      subject: { reference: "#local" },
      encounter: { reference: "https://example.test/fhir/Encounter/123" },
      performer: [{ reference: "urn:uuid:22222222-2222-4222-8222-222222222222" }],
      specimen: { reference: "Specimen/not a FHIR id" },
      valueString: "Patient/22222222-2222-4222-8222-222222222222"
    });

    expect(edges).toEqual([]);
  });

  test("escapes object keys in JSON pointer paths", () => {
    const edges = extractExplicitReferences({
      resourceType: "Observation",
      id: "11111111-1111-4111-8111-111111111111",
      "a/b~c": {
        reference: "Specimen/55555555-5555-4555-8555-555555555555"
      }
    });

    expect(edges[0]?.jsonPath).toBe("/a~1b~0c/reference");
  });
});
