import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { parseJsonlRecords } from "./jsonl.js";

const recordSchema = z.strictObject({ id: z.string().min(1), n: z.number() });
const idOf = (r: { id: string }): string => r.id;

describe("parseJsonlRecords (shared strict loader)", () => {
  test("parses valid records and skips blank lines", () => {
    const r = parseJsonlRecords('{"id":"a","n":1}\n\n{"id":"b","n":2}\n', recordSchema, idOf);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.map((v) => v.id)).toEqual(["a", "b"]);
  });

  test("an empty document is ok with zero records (callers decide if empty is valid)", () => {
    const r = parseJsonlRecords("\n  \n", recordSchema, idOf);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(0);
  });

  test("a non-JSON line fails loud with its line number", () => {
    const r = parseJsonlRecords('{"id":"a","n":1}\nnot json\n', recordSchema, idOf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.join(" ")).toContain("line 2: not valid JSON");
  });

  test("a schema-invalid line fails loud", () => {
    const r = parseJsonlRecords('{"id":"a"}\n', recordSchema, idOf);
    expect(r.ok).toBe(false);
  });

  test("a duplicate id is rejected", () => {
    const r = parseJsonlRecords('{"id":"a","n":1}\n{"id":"a","n":2}\n', recordSchema, idOf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.issues.join(" ")).toContain("duplicate id a");
  });
});
