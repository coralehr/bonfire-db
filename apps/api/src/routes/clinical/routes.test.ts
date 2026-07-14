/**
 * Production-composition integration battery for the TicVision read seam.
 * All identities and FHIR-shaped data are synthetic. Requests enter through
 * buildApp, so the test covers JWT verification, membership binding, RLS,
 * hybrid search, CCP construction, and the public HTTP result envelope.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { JsonObject, TenantDb } from "@bonfire/core";
import {
  ccpDocumentSchema,
  indexResourceTx,
  insertFhirResourceTx,
  MAX_SEARCH_QUERY_LENGTH,
  searchResponseSchema
} from "@bonfire/core";
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import type { AuthenticatedAppHarness } from "../../testing/authenticated-app.test.js";
import { createAuthenticatedAppHarness } from "../../testing/authenticated-app.test.js";

const QUERY = `ticvision-${randomUUID()}`;
const DB_TIMEOUT_MS = 30_000;

const okSearchSchema = z.object({ ok: z.literal(true), data: searchResponseSchema });
const okContextSchema = z.object({ ok: z.literal(true), data: ccpDocumentSchema });

let tenantDb: TenantDb;
let owner: Sql;
let app: FastifyInstance;
let harness: AuthenticatedAppHarness;

beforeAll(async () => {
  harness = await createAuthenticatedAppHarness({
    issuerPrefix: "ticvision",
    clockToleranceSeconds: 0,
    tenantPoolMax: 4
  });
  ({ app, tenantDb, owner } = harness);
});

afterAll(async () => {
  await harness.close();
});

const enroll = (practiceId: string, role: "clinician" | "biller" = "clinician") =>
  harness.enroll(practiceId, role);

async function seedObservation(practiceId: string, marker: string): Promise<string> {
  const id = randomUUID();
  const content: JsonObject = {
    resourceType: "Observation",
    id,
    status: "final",
    code: {
      coding: [
        {
          system: "http://example.org/synthetic/ticvision",
          code: marker,
          display: `Synthetic ${marker}`
        }
      ]
    },
    note: [{ text: `${marker} synthetic observation` }]
  };
  const seeded = await tenantDb.withTenant(practiceId, async (sql) => {
    const inserted = await insertFhirResourceTx(sql, {
      id,
      type: "Observation",
      content,
      rawPayload: JSON.stringify(content)
    });
    if (!inserted.ok) throw new Error(inserted.error.code);
    const indexed = await indexResourceTx(sql, id);
    if (!indexed.ok) throw new Error(indexed.error.code);
  });
  if (!seeded.ok) throw new Error(`seed failed: ${seeded.error.code}`);
  return id;
}

async function post(token: string, url: "/search" | "/context", payload: unknown) {
  return app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    payload
  });
}

describe("authenticated clinical read surface", () => {
  test(
    "search derives Practice and actor from membership and returns only that Practice",
    async () => {
      const practiceA = randomUUID();
      const practiceB = randomUUID();
      const tokenA = await enroll(practiceA);
      const ownId = await seedObservation(practiceA, QUERY);
      const otherId = await seedObservation(practiceB, QUERY);

      const response = await post(tokenA, "/search", {
        query: QUERY,
        purposeOfUse: "TREAT"
      });

      expect(response.statusCode).toBe(200);
      const result = okSearchSchema.parse(response.json());
      expect(result.data.results.map((hit) => hit.resourceId)).toContain(ownId);
      expect(result.data.results.map((hit) => hit.resourceId)).not.toContain(otherId);
    },
    DB_TIMEOUT_MS
  );

  test(
    "context performs server-side search then returns a cited CCP for the bound Practice",
    async () => {
      const practice = randomUUID();
      const token = await enroll(practice);
      const resourceId = await seedObservation(practice, QUERY);

      const response = await post(token, "/context", {
        query: QUERY,
        purposeOfUse: "TREAT"
      });

      expect(response.statusCode).toBe(200);
      const result = okContextSchema.parse(response.json());
      expect(result.data.practiceId).toBe(practice);
      expect(result.data.spans.length).toBeGreaterThan(0);
      expect(result.data.spans.every((span) => span.resourceId === resourceId)).toBe(true);
      expect(result.data.spans.every((span) => /^[0-9a-f]{64}$/.test(span.auditHash))).toBe(true);
    },
    DB_TIMEOUT_MS
  );

  test(
    "non-clinician membership denies search and context without disclosing resource ids",
    async () => {
      const practice = randomUUID();
      const token = await enroll(practice, "biller");
      const resourceId = await seedObservation(practice, QUERY);

      const searched = await post(token, "/search", {
        query: QUERY,
        purposeOfUse: "TREAT"
      });
      expect(searched.statusCode).toBe(200);
      const searchBody: unknown = searched.json();
      expect(searchBody).toMatchObject({ ok: true });
      const searchResult = okSearchSchema.parse(searchBody).data;
      expect(searchResult.results).toEqual([]);
      expect(searchResult.policyReceipt.decision).toBe("deny");
      expect(JSON.stringify(searchResult)).not.toContain(resourceId);

      const contextualized = await post(token, "/context", {
        query: QUERY,
        purposeOfUse: "TREAT"
      });
      expect(contextualized.statusCode).toBe(403);
      const contextBody: unknown = contextualized.json();
      expect(contextBody).toEqual({
        ok: false,
        error: { code: "CONTEXT_FORBIDDEN", message: "context request is not authorized" }
      });
      expect(JSON.stringify(contextBody)).not.toContain(resourceId);

      const [audit] = await owner`
        select count(*)::int as denials from audit_log
        where practice_id = ${practice} and decision = 'deny'`;
      expect(Number(audit?.denials)).toBeGreaterThanOrEqual(2);
    },
    DB_TIMEOUT_MS
  );

  test(
    "expired JWT is rejected before clinical data access",
    async () => {
      const practice = randomUUID();
      const token = await enroll(practice);
      const [, payload] = token.split(".");
      expect(payload).toBeDefined();
      const sub = JSON.parse(Buffer.from(payload ?? "", "base64url").toString()).sub as string;
      const expired = await harness.signToken(sub, "-1s");

      const response = await post(expired, "/search", {
        query: QUERY,
        purposeOfUse: "TREAT"
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ ok: false, error: { code: "UNAUTHENTICATED" } });
    },
    DB_TIMEOUT_MS
  );

  test(
    "client-supplied identity, role, or Practice is rejected as malformed input",
    async () => {
      const practice = randomUUID();
      const token = await enroll(practice);

      const response = await post(token, "/search", {
        query: QUERY,
        purposeOfUse: "TREAT",
        practiceId: randomUUID(),
        subject: { id: "forged", role: "clinician", practiceId: practice }
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        ok: false,
        error: { code: "SEARCH_INVALID_INPUT", message: "search request is malformed" }
      });
    },
    DB_TIMEOUT_MS
  );

  test(
    "both read routes enforce strict request boundaries with stable 400 errors",
    async () => {
      const practice = randomUUID();
      const token = await enroll(practice);
      const invalidPayloads = [
        { query: "", purposeOfUse: "TREAT" },
        { query: "x".repeat(MAX_SEARCH_QUERY_LENGTH + 1), purposeOfUse: "TREAT" },
        { query: QUERY, purposeOfUse: "TREAT", topN: 0 },
        { query: QUERY, purposeOfUse: "TREAT", topN: 101 },
        { query: QUERY, purposeOfUse: "TREAT", topN: 1.5 },
        { query: QUERY, purposeOfUse: "INVALID" },
        { query: QUERY, purposeOfUse: "TREAT", role: "clinician" }
      ];

      for (const url of ["/search", "/context"] as const) {
        for (const payload of invalidPayloads) {
          const response = await post(token, url, payload);
          expect(response.statusCode).toBe(400);
          expect(response.json()).toEqual({
            ok: false,
            error: { code: "SEARCH_INVALID_INPUT", message: "search request is malformed" }
          });
        }
        for (const topN of [1, 100]) {
          const response = await post(token, url, {
            query: `boundary-${randomUUID()}`,
            purposeOfUse: "TREAT",
            topN
          });
          expect(response.statusCode).toBe(200);
        }
      }
    },
    DB_TIMEOUT_MS
  );
});
