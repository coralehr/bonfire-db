import { describe, expect, test } from "bun:test";
import { parseReferenceTargets } from "./sql-reader.js";

describe("reference SQL reader", () => {
  test("fails closed when canonical content identity disagrees with selected columns", () => {
    expect(() =>
      parseReferenceTargets([
        {
          resource_type: "Observation",
          resource_id: "22222222-2222-4222-8222-222222222222",
          version_id: "1",
          last_updated: "2026-07-13T00:00:00.000Z",
          content: {
            resourceType: "Observation",
            id: "33333333-3333-4333-8333-333333333333"
          }
        }
      ])
    ).toThrow("resolved target content identity does not match its canonical row");
  });
});
