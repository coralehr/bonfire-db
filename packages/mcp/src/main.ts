/**
 * bonfire-mcp stdio entry (D5: fail-closed startup). Identity comes ONLY from
 * the environment (BONFIRE_TOKEN + issuer config) -> authenticate -> a
 * per-session server. An authentication failure exits NON-ZERO with zero
 * tools registered — there is no ambient/default session — and tool arguments
 * can never influence identity or scope.
 */
import { connectTenantDb } from "@bonfire/core";
import { authenticate, createSessionVerifier } from "@bonfire/sdk";
import { z } from "zod";
import { createBonfireMcpServer, createStdioTransport } from "./server.js";

const DEFAULT_ALGORITHMS = "RS256";
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 30;
const DEFAULT_MAX_TOKEN_AGE_SECONDS = 3600;

const envSchema = z.object({
  BONFIRE_TOKEN: z.string().min(1),
  BONFIRE_ISSUER: z.string().min(1),
  BONFIRE_JWKS_URI: z.string().min(1),
  BONFIRE_AUDIENCE: z.string().min(1),
  BONFIRE_ALGORITHMS: z.string().min(1).default(DEFAULT_ALGORITHMS),
  BONFIRE_CLOCK_TOLERANCE_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .default(DEFAULT_CLOCK_TOLERANCE_SECONDS),
  BONFIRE_MAX_TOKEN_AGE_SECONDS: z.coerce
    .number()
    .int()
    .min(1)
    .default(DEFAULT_MAX_TOKEN_AGE_SECONDS)
});

function fail(message: string): number {
  process.stderr.write(`bonfire-mcp: ${message}\n`);
  return 1;
}

async function main(): Promise<number> {
  const env = envSchema.safeParse(process.env);
  if (!env.success) {
    return fail("invalid environment: BONFIRE_TOKEN/ISSUER/JWKS_URI/AUDIENCE are required");
  }
  const db = connectTenantDb();
  const verifier = createSessionVerifier({
    issuer: env.data.BONFIRE_ISSUER,
    jwksUri: env.data.BONFIRE_JWKS_URI,
    audience: env.data.BONFIRE_AUDIENCE,
    algorithms: env.data.BONFIRE_ALGORITHMS.split(","),
    clockToleranceSeconds: env.data.BONFIRE_CLOCK_TOLERANCE_SECONDS,
    maxTokenAgeSeconds: env.data.BONFIRE_MAX_TOKEN_AGE_SECONDS
  });
  const authed = await authenticate({ db, verifier, token: env.data.BONFIRE_TOKEN });
  if (!authed.ok) {
    await db.end();
    return fail(`authentication failed (${authed.error.code}); no tools registered`);
  }
  const server = createBonfireMcpServer({ db, session: authed.data });
  server.server.onclose = (): void => {
    void db.end();
  };
  await server.connect(createStdioTransport());
  return 0;
}

process.exitCode = await main();
