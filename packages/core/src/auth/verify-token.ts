/**
 * `verifyToken` — the load-bearing external-identity boundary (BF-13).
 *
 * It verifies a compact JWT against a cached, kid-aware JWKS fetched from the
 * configured IdP (key rotation is transparent), enforces a POSITIVE `alg`
 * allow-list (the alg comes from config, never the token header — this is what
 * defeats alg:none and RS256->HS256 confusion), and asserts iss/aud/exp. It
 * returns a typed `Result` and NEVER throws across the boundary: every jose
 * throw is caught and mapped to a deny (`err(AuthError)`), and a catch never
 * returns `ok`. It resolves NO tenant context — that is the membership layer's
 * job — so a verification failure leaves BF-01's default-deny RLS at zero rows.
 */
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Result } from "../result.js";
import { err, ok } from "../result.js";
import type { AuthError } from "./errors.js";
import { authError, mapJoseError } from "./errors.js";
import type { VerifiedIdentity, VerifyTokenConfig } from "./types.js";
import { DEFAULT_FHIR_USER_CLAIM, verifiedClaimsSchema } from "./types.js";

/** Remote JWKS cache tuning (ms). Named so no magic number leaks into the call. */
const JWKS_CACHE_MAX_AGE_MS = 600_000;
const JWKS_COOLDOWN_MS = 30_000;
const JWKS_TIMEOUT_MS = 5_000;

/** A verifier holds its JWKS resolver so the remote key set is built ONCE. */
export interface Verifier {
  verifyToken(token: string): Promise<Result<VerifiedIdentity, AuthError>>;
}

function remoteKeySet(config: VerifyTokenConfig): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(config.jwksUri), {
    cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
    cooldownDuration: JWKS_COOLDOWN_MS,
    timeoutDuration: JWKS_TIMEOUT_MS
  });
}

/** Project a verified jose payload onto the trusted identity shape (Zod-parsed). */
function toIdentity(
  payload: JWTPayload,
  config: VerifyTokenConfig
): Result<VerifiedIdentity, AuthError> {
  const fhirUserClaim = config.claimNames?.fhirUser ?? DEFAULT_FHIR_USER_CLAIM;
  const parsed = verifiedClaimsSchema.safeParse({
    iss: payload.iss,
    sub: payload.sub,
    fhirUser: payload[fhirUserClaim]
  });
  if (!parsed.success) return err(authError("CLAIMS_SHAPE_INVALID"));
  const { iss, sub, fhirUser } = parsed.data;
  // Omit fhirUser entirely when absent (exactOptionalPropertyTypes): the type
  // forbids an explicit `undefined`, and there is no authority attribute to add.
  const identity: VerifiedIdentity = fhirUser === undefined ? { iss, sub } : { iss, sub, fhirUser };
  return ok(identity);
}

async function verifyWithKeySet(
  token: string,
  config: VerifyTokenConfig,
  resolveKey: JWTVerifyGetKey
): Promise<Result<VerifiedIdentity, AuthError>> {
  try {
    const { payload } = await jwtVerify(token, resolveKey, {
      algorithms: [...config.algorithms],
      issuer: config.issuer,
      audience: config.audience,
      clockTolerance: config.clockToleranceSeconds
    });
    return toIdentity(payload, config);
  } catch (cause) {
    // Fail-closed: EVERY jose throw becomes a typed deny. A catch never yields ok.
    return err(mapJoseError(cause));
  }
}

/**
 * Build a reusable verifier. In production `keySet` is omitted and a cached
 * remote JWKS is constructed once (lazy — no network until the first verify).
 * Tests inject a `createLocalJWKSet` so the whole path runs with no network.
 */
export function createVerifier(config: VerifyTokenConfig, keySet?: JWTVerifyGetKey): Verifier {
  const resolveKey = keySet ?? remoteKeySet(config);
  return {
    verifyToken(token: string): Promise<Result<VerifiedIdentity, AuthError>> {
      return verifyWithKeySet(token, config, resolveKey);
    }
  };
}

/**
 * One-shot verify (builds a fresh remote JWKS per call unless `keySet` is
 * injected). Prefer {@link createVerifier} in production to share the cache.
 */
export function verifyToken(
  token: string,
  config: VerifyTokenConfig,
  keySet?: JWTVerifyGetKey
): Promise<Result<VerifiedIdentity, AuthError>> {
  return verifyWithKeySet(token, config, keySet ?? remoteKeySet(config));
}
