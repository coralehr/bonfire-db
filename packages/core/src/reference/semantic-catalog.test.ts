import { describe, expect, test } from "bun:test";
import {
  isAllowedReferenceEdge,
  REFERENCE_PROFILES,
  referenceProfile
} from "./semantic-catalog.js";

describe("reference traversal semantic catalog", () => {
  test("measured microbiology profile contains only the frozen QT-4 path families", () => {
    const profile = referenceProfile("micro-evidence-v1");

    expect(profile.evidenceStatus).toBe("measured-exploratory");
    expect(profile.rules.map((rule) => `${rule.sourceType}.${rule.pathFamily}`)).toEqual([
      "DiagnosticReport.result",
      "DiagnosticReport.specimen",
      "Observation.hasMember",
      "Observation.specimen"
    ]);
  });

  test("matches source, pointer shape, and target type together", () => {
    expect(
      isAllowedReferenceEdge("micro-evidence-v1", {
        sourceResourceType: "Observation",
        jsonPath: "/hasMember/0/reference",
        targetResourceType: "Observation"
      })
    ).toBe(true);
    expect(
      isAllowedReferenceEdge("micro-evidence-v1", {
        sourceResourceType: "Observation",
        jsonPath: "/hasMember/0/reference",
        targetResourceType: "Specimen"
      })
    ).toBe(false);
    expect(
      isAllowedReferenceEdge("micro-evidence-v1", {
        sourceResourceType: "Observation",
        jsonPath: "/performer/0/reference",
        targetResourceType: "Practitioner"
      })
    ).toBe(false);
  });

  test("labels the broader clinical profile experimental rather than measured", () => {
    expect(REFERENCE_PROFILES["clinical-reference-v1"].evidenceStatus).toBe(
      "experimental-unvalidated"
    );
  });
});
