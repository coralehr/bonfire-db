/**
 * The declared leaf-path table + walk (D2b, Class 4a). Proves the structural
 * belt: only declared paths resolve, a non-scalar resolution THROWS (a subtree
 * could smuggle a `system` URI or reference id into a span), and the table
 * covers exactly the searchable clinical types. All fixtures are synthetic.
 */
import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../db/canonical-json.js";
import { SEARCHABLE_TYPES } from "../search/derive-scope.js";
import { LEAF_PATHS, resolvePath } from "./leaf-paths.js";

const condition: JsonObject = {
  resourceType: "Condition",
  code: {
    coding: [
      { system: "http://example.org/synthetic", code: "synth-001", display: "Synthetic HTN" }
    ],
    text: "synthetic hypertension"
  },
  clinicalStatus: { coding: [{ code: "active" }] },
  onsetDateTime: "2024-01-15",
  note: [{ text: "stable on synthetic therapy" }]
};

describe("resolvePath — declared dotted-path walk", () => {
  test("resolves nested object segments to a string leaf", () => {
    expect(resolvePath(condition, "code.coding.0.display")).toBe("Synthetic HTN");
    expect(resolvePath(condition, "code.text")).toBe("synthetic hypertension");
  });

  test("numeric segments index arrays; non-numeric segments on an array miss", () => {
    expect(resolvePath(condition, "note.0.text")).toBe("stable on synthetic therapy");
    expect(resolvePath(condition, "note.first.text")).toBeUndefined();
  });

  test("numeric leaves resolve as numbers", () => {
    const obs: JsonObject = { valueQuantity: { value: 7.25, unit: "mmol/L" } };
    expect(resolvePath(obs, "valueQuantity.value")).toBe(7.25);
    expect(resolvePath(obs, "valueQuantity.unit")).toBe("mmol/L");
  });

  test("missing fields, null leaves, and scalar mid-path all resolve undefined", () => {
    expect(resolvePath(condition, "abatementDateTime")).toBeUndefined();
    expect(resolvePath({ note: null }, "note.0.text")).toBeUndefined();
    expect(resolvePath({ status: "final" }, "status.coding.0.code")).toBeUndefined();
  });

  test("a declared path resolving to an OBJECT throws (Class 4a, non-scalar leaf)", () => {
    expect(() => resolvePath(condition, "code.coding.0")).toThrow(/non-scalar/);
  });

  test("a declared path resolving to an ARRAY throws (Class 4a, non-scalar leaf)", () => {
    expect(() => resolvePath(condition, "code.coding")).toThrow(/non-scalar/);
  });
});

describe("LEAF_PATHS — the declared table", () => {
  test("covers exactly the searchable clinical types", () => {
    expect(Object.keys(LEAF_PATHS).sort()).toEqual([...SEARCHABLE_TYPES].sort());
  });

  test("no declared path names an id, reference, or system URI leaf", () => {
    for (const paths of Object.values(LEAF_PATHS)) {
      for (const path of paths) {
        expect(path).not.toMatch(/(^|\.)(id|reference|system|url)($|\.)/);
      }
    }
  });
});
