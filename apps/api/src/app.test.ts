/**
 * Production app composition contract. These tests stay DB-free: an unauthenticated
 * request must be rejected at the shared auth boundary before a clinical handler can
 * touch tenant data. DB-backed success paths remain in the route integration suites.
 */
import { describe, expect, test } from "bun:test";
import type { TenantDb, Verifier } from "@bonfire/core";
import { err, ok } from "@bonfire/core";
import { buildApp } from "./app.js";

const AUDIT_ROW_HASH = "0".repeat(64);

function appDeps(): {
  readonly auth: { readonly verifier: Verifier; readonly tenantDb: TenantDb };
  readonly tenantDbEnds: () => number;
} {
  let endCalls = 0;
  const tenantDb = {
    withTenant: async <T>(): Promise<ReturnType<typeof ok<T>>> =>
      ok({ auditRowHash: AUDIT_ROW_HASH } as T),
    resolveMembership: async () => ok(null),
    end: async () => {
      endCalls += 1;
    }
  } satisfies TenantDb;
  const verifier: Verifier = {
    verifyToken: async () =>
      err({ code: "VERIFY_FAILED", message: "test verifier must not run without a token" })
  };
  return { auth: { verifier, tenantDb }, tenantDbEnds: () => endCalls };
}

describe("buildApp authenticated surface", () => {
  test("registers search, context, and governance behind one fail-closed boundary", async () => {
    const deps = appDeps();
    const app = buildApp({ authDeps: deps.auth });
    try {
      for (const url of [
        "/search",
        "/context",
        "/governance/proposals",
        `/governance/proposals/${crypto.randomUUID()}/approve`,
        `/governance/proposals/${crypto.randomUUID()}/commit`
      ]) {
        const response = await app.inject({ method: "POST", url, payload: {} });
        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ ok: false, error: { code: "UNAUTHENTICATED" } });
      }
    } finally {
      await app.close();
    }
    expect(deps.tenantDbEnds()).toBe(1);
  });

  test("membership lookup failure is an opaque 500, never a false 403", async () => {
    let auditAttempts = 0;
    const tenantDb = {
      withTenant: async <T>(): Promise<ReturnType<typeof ok<T>>> => {
        auditAttempts += 1;
        return ok({ auditRowHash: AUDIT_ROW_HASH } as T);
      },
      resolveMembership: async () =>
        err({ code: "TENANT_TX_FAILED" as const, message: "synthetic lookup failure" }),
      end: async () => undefined
    } satisfies TenantDb;
    const verifier: Verifier = {
      verifyToken: async () => ok({ iss: "https://idp.synthetic.test/", sub: "lookup-failure" })
    };
    const app = buildApp({ authDeps: { verifier, tenantDb } });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/search",
        headers: { authorization: "Bearer synthetic-token" },
        payload: { query: "synthetic", purposeOfUse: "TREAT" }
      });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        ok: false,
        error: { code: "AUTH_MEMBERSHIP_LOOKUP_FAILED" }
      });
      expect(auditAttempts).toBe(1);
    } finally {
      await app.close();
    }
  });
});
