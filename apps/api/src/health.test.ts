/**
 * BF-01 /health behavior tests over a REAL listener (fastify.inject is flaky
 * under bun test, so: listen on port 0 + fetch).
 *
 * Success path expects the compose db to be up (verify order: compose up ->
 * db:migrate -> tests). Failure path builds the app against a dead port and
 * proves the typed error Result, non-2xx status, no leak, and the hard timeout
 * (completes well under 5s — no hang, no uncaught throw).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { buildApp } from "./app.js";

const DEAD_PORT_URL = "postgres://bonfire_app:bonfire-dev-only-app-pw@127.0.0.1:59999/bonfire";
const ERROR_CODES = ["DB_UNAVAILABLE", "DB_CONNECT_TIMEOUT", "HEALTH_TIMEOUT", "PGVECTOR_MISSING"];

describe("GET /health", () => {
  const liveApp = buildApp();
  const deadApp = buildApp({ databaseUrl: DEAD_PORT_URL });

  afterAll(async () => {
    await liveApp.close();
    await deadApp.close();
  });

  test("healthy db -> 200 { ok:true, db:'up', pgvector:'present' }", async () => {
    const address = await liveApp.listen({ host: "127.0.0.1", port: 0 });
    const response = await fetch(`${address}/health`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.db).toBe("up");
    expect(body.pgvector).toBe("present");
    expect(typeof body.pgvectorVersion).toBe("string");
    expect(typeof body.latencyMs).toBe("number");
  });

  test("unreachable db -> 503 typed error Result, fast, no internals leaked", async () => {
    const address = await deadApp.listen({ host: "127.0.0.1", port: 0 });
    const startedAt = Date.now();
    const response = await fetch(`${address}/health`);
    const elapsedMs = Date.now() - startedAt;
    expect(response.status).toBe(503);
    expect(elapsedMs).toBeLessThan(5000);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(ERROR_CODES).toContain(body.error.code);
    // Opaque error only: exactly { ok, error: { code } } — no message/stack/query.
    expect(Object.keys(body).sort()).toEqual(["error", "ok"]);
    expect(Object.keys(body.error)).toEqual(["code"]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("stack");
    expect(raw).not.toContain("ECONNREFUSED");
  });
});
