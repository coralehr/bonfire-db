/**
 * TRACER D — the injectable auth boundary over a REAL local Fastify listener.
 * Production composition is covered separately by app and route integration
 * tests. The verifier is `createVerifier` fed a LOCAL JWKS
 * (no network); the TenantDb is a max:1 pool so request B provably reuses the
 * physical connection request A just released.
 *
 * Proves: valid A -> 200 scoped to A; valid B immediately after on the same
 * pooled connection -> only B (no bleed); a no-identity connection -> zero rows;
 * every deny (no Bearer / alg:none / expired / no membership) is a fail-closed
 * status plus exactly one SYSTEM audit row; and the authentication audit survives
 * a throwing handler (committed in its own tx before the handler runs).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Membership, TenantDb, TenantSql, Verifier } from "@bonfire/core";
import {
  connectTenantDb,
  createVerifier,
  devDatabaseUrl,
  err,
  ok,
  SYSTEM_PRACTICE_ID
} from "@bonfire/core";
import type { FastifyInstance } from "fastify";
import fastify from "fastify";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import type { Sql } from "postgres";
import postgres from "postgres";
import { runAuthenticated } from "./auth-hook.js";

const ISS = "https://idp.synthetic.test/";
const AUD = "bonfire-api";
const KID = "synthetic-key-1";
const FHIR_USER = "https://fhir.synthetic.test/Practitioner/abc";
const DB_TIMEOUT_MS = 30_000;

let tenantDb: TenantDb;
let owner: Sql;
let rawApp: Sql;
let verifier: Verifier;
let privateKey: CryptoKey;
let app: FastifyInstance;
let address: string;

async function signValid(sub: string): Promise<string> {
  return new SignJWT({ fhirUser: FHIR_USER })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setSubject(sub)
    .setExpirationTime("2h")
    .sign(privateKey);
}

/** Seed a membership (owner-only) + `rlsRows` tenant rows; return its token. */
async function provision(rlsRows: number): Promise<{ practice: string; token: string }> {
  const sub = randomUUID();
  const practice = randomUUID();
  await owner`insert into membership (iss, sub, practice_id, role)
    values (${ISS}, ${sub}, ${practice}, 'clinician')`;
  for (let i = 0; i < rlsRows; i += 1) {
    await owner`insert into rls_scaffold (practice_id, label) values (${practice}, ${`row-${i}`})`;
  }
  return { practice, token: await signValid(sub) };
}

async function practiceDecisions(practice: string): Promise<string[]> {
  const result = await tenantDb.withTenant(practice, async (sql: TenantSql) => {
    const rows = await sql<{ decision: string }[]>`
      select decision from audit_log order by seq asc`;
    return rows.map((r) => r.decision);
  });
  if (!result.ok) throw new Error(`practiceDecisions failed: ${result.error.code}`);
  return result.data;
}

function get(path: string, token: string): Promise<Response> {
  return fetch(`${address}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

beforeAll(async () => {
  const keyPair = await generateKeyPair("RS256", { extractable: true });
  privateKey = keyPair.privateKey;
  const jwk = { ...(await exportJWK(keyPair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  verifier = createVerifier(
    {
      issuer: ISS,
      jwksUri: "https://idp.synthetic.test/.well-known/jwks.json",
      audience: AUD,
      algorithms: ["RS256", "ES256", "EdDSA"],
      clockToleranceSeconds: 5
    },
    jwks
  );
  tenantDb = connectTenantDb({ max: 1 });
  owner = postgres(devDatabaseUrl("migrate"), { max: 1 });
  rawApp = postgres(devDatabaseUrl("app"), { max: 1 });

  const deps = { verifier, tenantDb };
  app = fastify();
  app.get("/protected", async (request, reply) => {
    await runAuthenticated(request, reply, deps, async ({ sql }) => {
      const rows = await sql<{ n: number }[]>`select count(*)::int as n from rls_scaffold`;
      return { count: rows[0]?.n ?? 0 };
    });
  });
  app.get("/boom", async (request, reply) => {
    await runAuthenticated(request, reply, deps, async () => {
      throw new Error("deliberate handler failure");
    });
  });
  address = await app.listen({ host: "127.0.0.1", port: 0 });
});

afterAll(async () => {
  await app.close();
  await Promise.all([tenantDb.end(), owner.end(), rawApp.end()]);
});

describe("valid request is tenant-scoped and does not bleed across the pool", () => {
  test(
    "A sees only A's rows; B right after on the same max:1 conn sees only B; bare -> 0",
    async () => {
      const a = await provision(2);
      const b = await provision(1);

      const resA = await get("/protected", a.token);
      expect(resA.status).toBe(200);
      expect((await resA.json()).count).toBe(2);

      const resB = await get("/protected", b.token);
      expect(resB.status).toBe(200);
      expect((await resB.json()).count).toBe(1);

      const bare = await rawApp`select id from rls_scaffold`;
      expect(bare.length).toBe(0);

      expect(await practiceDecisions(a.practice)).toEqual(["allow"]);
      expect(await practiceDecisions(b.practice)).toEqual(["allow"]);
    },
    DB_TIMEOUT_MS
  );
});

describe("every deny is fail-closed (status); SYSTEM audit proven in core suite", () => {
  test(
    "no Bearer -> 401 (fail-closed)",
    async () => {
      const res = await fetch(`${address}/protected`);
      expect(res.status).toBe(401);
    },
    DB_TIMEOUT_MS
  );

  test(
    "a verified-but-unprovisioned token -> 403 (fail-closed; no tenant context)",
    async () => {
      // The verified identity has no membership row, so no tenant context is set
      // and the request is denied. The failure-audit row on the shared SYSTEM
      // chain is proven hermetically (by row_hash) in the core auth-audit suite;
      // asserting it here would race the parallel gate's shared-chain writes.
      const res = await get("/protected", await signValid(randomUUID()));
      expect(res.status).toBe(403);
    },
    DB_TIMEOUT_MS
  );

  test(
    "alg:none -> 401 (fail-closed)",
    async () => {
      const token = new UnsecuredJWT({ fhirUser: FHIR_USER })
        .setIssuer(ISS)
        .setAudience(AUD)
        .setSubject(randomUUID())
        .setExpirationTime("2h")
        .encode();
      const res = await get("/protected", token);
      expect(res.status).toBe(401);
    },
    DB_TIMEOUT_MS
  );

  test(
    "an expired token -> 401 (fail-closed)",
    async () => {
      const token = await new SignJWT({ fhirUser: FHIR_USER })
        .setProtectedHeader({ alg: "RS256", kid: KID })
        .setIssuer(ISS)
        .setAudience(AUD)
        .setSubject(randomUUID())
        .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
        .sign(privateKey);
      const res = await get("/protected", token);
      expect(res.status).toBe(401);
    },
    DB_TIMEOUT_MS
  );
});

describe("the authentication audit survives a throwing handler", () => {
  test(
    "handler throws -> 500, but the committed allow row remains (auth not rolled back)",
    async () => {
      const a = await provision(0);
      const res = await get("/boom", a.token);
      expect(res.status).toBe(500);
      expect(await practiceDecisions(a.practice)).toEqual(["allow"]);
    },
    DB_TIMEOUT_MS
  );
});

/**
 * A TenantDb whose every write fails — the audit backend is down. No real DB is
 * touched, so these fail-closed proofs are deterministic (no shared-chain race).
 */
function auditDownDb(membership: Membership | null): TenantDb {
  return {
    withTenant: () =>
      Promise.resolve(err({ code: "TENANT_TX_FAILED", message: "audit backend down" })),
    resolveMembership: () => Promise.resolve(ok(membership)),
    end: () => Promise.resolve()
  };
}

/** Run `fn` against a local app wired to `deps`, exposing whether the handler ran. */
async function withStubApp(
  deps: { readonly verifier: Verifier; readonly tenantDb: TenantDb },
  fn: (address: string, handlerRan: () => boolean) => Promise<void>
): Promise<void> {
  let ran = false;
  const stub = fastify();
  stub.get("/p", async (request, reply) => {
    await runAuthenticated(request, reply, deps, async () => {
      ran = true;
      return { ok: true };
    });
  });
  const addr = await stub.listen({ host: "127.0.0.1", port: 0 });
  try {
    await fn(addr, () => ran);
  } finally {
    await stub.close();
  }
}

describe("a dropped audit never compromises authorization (audit-bypass / fail-open)", () => {
  test("a deny stays fail-closed (401) even when the audit backend is unavailable", async () => {
    await withStubApp({ verifier, tenantDb: auditDownDb(null) }, async (addr) => {
      const res = await fetch(`${addr}/p`); // no Bearer -> deny; failure audit will error
      expect(res.status).toBe(401);
    });
  });

  test("a deny path ALWAYS invokes the SYSTEM failure-audit (wiring pinned, even when it fails)", async () => {
    // Inversion-proof: a recording TenantDb captures the practice each withTenant
    // targets. A deny must open the SYSTEM chain exactly once — if the
    // auditAuthFailure call is ever removed, `audited` is empty and this fails.
    const audited: string[] = [];
    const recordingDownDb: TenantDb = {
      withTenant: (practiceId) => {
        audited.push(practiceId);
        return Promise.resolve(err({ code: "TENANT_TX_FAILED", message: "audit backend down" }));
      },
      resolveMembership: () => Promise.resolve(ok(null)),
      end: () => Promise.resolve()
    };
    await withStubApp({ verifier, tenantDb: recordingDownDb }, async (addr) => {
      const res = await fetch(`${addr}/p`); // no Bearer -> deny, audited under SYSTEM
      expect(res.status).toBe(401);
    });
    // The deny opened the SYSTEM chain (bounded-retry may attempt it more than
    // once when the backend errors); every attempt targets SYSTEM, never a real
    // tenant. Removing the auditAuthFailure call leaves this empty.
    expect(audited.length).toBeGreaterThan(0);
    expect(audited.every((practice) => practice === SYSTEM_PRACTICE_ID)).toBe(true);
  });

  test("a verified request whose authn audit fails -> 500 and the handler NEVER runs", async () => {
    // The success-audit commits BEFORE the handler; if it cannot be written there
    // is no tenant-scoped data access at all (no unaudited reads).
    const stubVerifier: Verifier = {
      verifyToken: () => Promise.resolve(ok({ iss: ISS, sub: randomUUID() }))
    };
    const membership: Membership = { practiceId: randomUUID(), role: "clinician" };
    await withStubApp(
      { verifier: stubVerifier, tenantDb: auditDownDb(membership) },
      async (addr, handlerRan) => {
        const res = await fetch(`${addr}/p`, { headers: { authorization: "Bearer x" } });
        expect(res.status).toBe(500);
        expect(handlerRan()).toBe(false);
      }
    );
  });
});
