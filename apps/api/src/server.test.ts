import { describe, expect, test } from "bun:test";

import type { HealthStatus } from "@bonfire/core";

import { buildServer } from "./server.js";

describe("GET /health", () => {
  test("returns the BF-01 health response", async () => {
    const server = buildServer();
    const response = await server.inject({
      method: "GET",
      url: "/health"
    });

    expect(response.statusCode).toBe(200);
    const payload = JSON.parse(response.body) as HealthStatus;
    expect(payload).toEqual({
      ok: true,
      service: "bonfire-api",
      version: "0.0.0",
      dependencies: {
        database: "configured"
      }
    });

    await server.close();
  });
});
