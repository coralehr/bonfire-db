/**
 * Engine unit behavior pinned outside the vendored suite: the LOCKED 3-way
 * scalarization, typed union/where errors, and the materializable tier's
 * structural requirements (reserved names, key column, name pattern).
 */
import { describe, expect, test } from "bun:test";
import { evaluateView, parseMaterializableView, parseViewDefinition } from "../index.js";

const patient = {
  resourceType: "Patient",
  id: "pt1",
  name: [
    { family: "Fam1", given: ["G1", "G2"] },
    { family: "Fam2", given: ["G3"] }
  ]
};

function mustParse(view: unknown): ReturnType<typeof parseViewDefinition> {
  return parseViewDefinition(view);
}

describe("scalarization (LOCKED 3-way rule) and typed engine errors", () => {
  test("empty resolves to null, single to scalar, collection to array", () => {
    const parsed = mustParse({
      resource: "Patient",
      select: [
        {
          column: [
            { name: "missing", path: "birthDate", type: "date" },
            { name: "one", path: "id", type: "id" },
            { name: "many", path: "name.given", type: "string", collection: true }
          ]
        }
      ]
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rows = evaluateView(parsed.data, patient);
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    expect(rows.data).toEqual([{ missing: null, one: "pt1", many: ["G1", "G2", "G3"] }]);
  });

  const errorCases: { title: string; view: unknown; code: string }[] = [
    {
      title: "multiple values without collection: true (never a silent first())",
      code: "VD_COLUMN_MULTIPLE_VALUES",
      view: {
        resource: "Patient",
        select: [{ column: [{ name: "many", path: "name.given", type: "string" }] }]
      }
    },
    {
      title: "unionAll branch column mismatch",
      code: "VD_UNION_COLUMN_MISMATCH",
      view: {
        resource: "Patient",
        select: [
          {
            unionAll: [
              { column: [{ name: "a", path: "id", type: "id" }] },
              { column: [{ name: "b", path: "id", type: "id" }] }
            ]
          }
        ]
      }
    },
    {
      title: "a non-boolean where clause",
      code: "VD_WHERE_NOT_BOOLEAN",
      view: {
        resource: "Patient",
        select: [{ column: [{ name: "id", path: "id", type: "id" }] }],
        where: [{ path: "name.family" }]
      }
    },
    {
      title: "a malformed FHIRPath expression",
      code: "VD_FHIRPATH_INVALID",
      view: {
        resource: "Patient",
        select: [{ column: [{ name: "id", path: "@@", type: "id" }] }]
      }
    }
  ];

  test.each(errorCases)("$title is the typed error $code", ({ view, code }) => {
    const parsed = mustParse(view);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const rows = evaluateView(parsed.data, patient);
    expect(rows.ok).toBe(false);
    if (!rows.ok) expect(rows.error.code).toBe(code);
  });
});

describe("materializable tier", () => {
  const keyColumn = { name: "id", path: "getResourceKey()", type: "id" };

  test("accepts a well-formed named view and resolves the key column", () => {
    const view = parseMaterializableView({
      name: "patient_demo",
      resource: "Patient",
      select: [{ column: [keyColumn, { name: "gender", path: "gender", type: "code" }] }]
    });
    expect(view.ok).toBe(true);
    if (view.ok) {
      expect(view.data.name).toBe("patient_demo");
      expect(view.data.keyColumn).toBe("id");
    }
  });

  test.each([
    "practice_id",
    "row_index",
    "version_id",
    "last_updated"
  ])("rejects reserved column name %s", (reserved) => {
    const view = parseMaterializableView({
      name: "bad_view",
      resource: "Patient",
      select: [{ column: [keyColumn, { name: reserved, path: "gender", type: "code" }] }]
    });
    expect(view.ok).toBe(false);
    if (!view.ok) expect(view.error.message).toContain("reserved");
  });

  test("rejects a view without a top-level getResourceKey() column", () => {
    const view = parseMaterializableView({
      name: "keyless",
      resource: "Patient",
      select: [{ column: [{ name: "gender", path: "gender", type: "code" }] }]
    });
    expect(view.ok).toBe(false);
    if (!view.ok) expect(view.error.message).toContain("getResourceKey");
  });

  test("a getResourceKey() column inside forEach does not count as the key", () => {
    const view = parseMaterializableView({
      name: "iterated_key",
      resource: "Patient",
      select: [{ forEach: "name", column: [keyColumn] }]
    });
    expect(view.ok).toBe(false);
  });

  test.each([
    "UpperCase",
    "1starts_with_digit",
    "has-dash",
    ""
  ])("rejects unsafe view name %s", (name) => {
    const view = parseMaterializableView({
      name,
      resource: "Patient",
      select: [{ column: [keyColumn] }]
    });
    expect(view.ok).toBe(false);
  });

  test("rejects duplicate column names across the select tree", () => {
    const view = parseMaterializableView({
      name: "dup_columns",
      resource: "Patient",
      select: [
        { column: [keyColumn, { name: "gender", path: "gender", type: "code" }] },
        { forEach: "name", column: [{ name: "gender", path: "family", type: "string" }] }
      ]
    });
    expect(view.ok).toBe(false);
    if (!view.ok) expect(view.error.message).toContain("duplicate");
  });
});
