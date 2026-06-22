import { describe, expect, test } from "bun:test";

import { getHealthStatus } from "./index.js";

describe("getHealthStatus", () => {
  test("returns the BF-01 API health payload", () => {
    expect(getHealthStatus()).toEqual({
      ok: true,
      service: "bonfire-api",
      version: "0.0.0",
      dependencies: {
        database: "configured"
      }
    });
  });
});
