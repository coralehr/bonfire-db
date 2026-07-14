import { randomUUID } from "node:crypto";
import type { Role, TenantDb, Verifier } from "@bonfire/core";
import { connectTenantDb, createVerifier, devDatabaseUrl } from "@bonfire/core";
import type { FastifyInstance } from "fastify";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Sql } from "postgres";
import postgres from "postgres";
import { buildApp } from "../app.js";

const AUDIENCE = "bonfire-api";
const KEY_ID = "api-integration-key";
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 5;

export interface AuthenticatedAppHarness {
  readonly app: FastifyInstance;
  readonly tenantDb: TenantDb;
  readonly owner: Sql;
  readonly issuer: string;
  enroll(practiceId: string, role: Role): Promise<string>;
  signToken(sub: string, expiration?: string): Promise<string>;
  close(): Promise<void>;
}

/** A no-network authenticated app for DB-backed API integration tests. */
export async function createAuthenticatedAppHarness(options: {
  readonly issuerPrefix: string;
  readonly clockToleranceSeconds?: number;
  readonly tenantPoolMax?: number;
}): Promise<AuthenticatedAppHarness> {
  const issuer = `https://idp.synthetic.test/${options.issuerPrefix}-${randomUUID()}`;
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const verifier: Verifier = createVerifier(
    {
      issuer,
      jwksUri: `${issuer}/.well-known/jwks.json`,
      audience: AUDIENCE,
      algorithms: ["RS256"],
      clockToleranceSeconds: options.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS
    },
    createLocalJWKSet({ keys: [{ ...jwk, kid: KEY_ID, alg: "RS256", use: "sig" }] })
  );
  const signToken = (sub: string, expiration = "1h"): Promise<string> =>
    new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: KEY_ID })
      .setIssuer(issuer)
      .setAudience(AUDIENCE)
      .setSubject(sub)
      .setExpirationTime(expiration)
      .sign(privateKey);
  const tenantDb = connectTenantDb({ max: options.tenantPoolMax ?? 2 });
  const owner = postgres(devDatabaseUrl("migrate"), { max: 1 });
  const app = buildApp({ authDeps: { verifier, tenantDb } });
  await app.ready();

  return {
    app,
    tenantDb,
    owner,
    issuer,
    signToken,
    enroll: async (practiceId, role) => {
      const sub = `human-${randomUUID()}`;
      await owner`insert into membership (iss, sub, practice_id, role)
        values (${issuer}, ${sub}, ${practiceId}, ${role})`;
      return signToken(sub);
    },
    close: async () => {
      await app.close();
      await owner.end();
    }
  };
}
