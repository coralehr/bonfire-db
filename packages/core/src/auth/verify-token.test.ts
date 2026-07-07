/**
 * TRACER A — pure token verification, NO DB and NO network.
 *
 * Keys are synthetic, generated in-test (generateKeyPair extractable ->
 * exportJWK -> createLocalJWKSet), so a real network fetch never happens and no
 * secret is committed. Beyond the two happy paths (a legit RS256 token and a
 * two-kid rotation), EIGHT fail-closed controls each assert `err(<code>)` and
 * never `ok` — the alg allow-list, iss/aud/exp assertion, kid resolution, and
 * the (iss,sub) claim-shape boundary. The alg is taken from config, never the
 * token header (defeats alg:none + RS256->HS256 confusion).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import type { JWK, JWTVerifyGetKey } from "jose";
import {
  createLocalJWKSet,
  exportJWK,
  exportSPKI,
  generateKeyPair,
  SignJWT,
  UnsecuredJWT
} from "jose";
import type { AuthErrorCode } from "./errors.js";
import type { VerifiedIdentity, VerifyTokenConfig } from "./types.js";
import { createVerifier, verifyToken } from "./verify-token.js";

const ISSUER = "https://idp.synthetic.test/";
const AUDIENCE = "bonfire-api";
const SUBJECT = "auth0|synthetic-user-1";
const FHIR_USER = "https://fhir.synthetic.test/Practitioner/abc";
const KID_1 = "synthetic-key-1";
const KID_2 = "synthetic-key-2";
const CLOCK_TOLERANCE_SECONDS = 5;
const ONE_HOUR_SECONDS = 3600;

const CONFIG: VerifyTokenConfig = {
  issuer: ISSUER,
  jwksUri: "https://idp.synthetic.test/.well-known/jwks.json",
  audience: AUDIENCE,
  algorithms: ["RS256", "ES256", "EdDSA"],
  clockToleranceSeconds: CLOCK_TOLERANCE_SECONDS
};

interface RsKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
}

let key1: RsKey;
let key2: RsKey;
let jwks: JWTVerifyGetKey;

async function publicJwk(publicKey: CryptoKey, kid: string): Promise<JWK> {
  const jwk = await exportJWK(publicKey);
  return { ...jwk, kid, alg: "RS256", use: "sig" };
}

beforeAll(async () => {
  key1 = await generateKeyPair("RS256", { extractable: true });
  key2 = await generateKeyPair("RS256", { extractable: true });
  jwks = createLocalJWKSet({
    keys: [await publicJwk(key1.publicKey, KID_1), await publicJwk(key2.publicKey, KID_2)]
  });
});

/**
 * Sign a token with the standard synthetic claims; each override breaks exactly
 * one property so a control test states its single deviation. `aud`/`sub` set to
 * null are OMITTED; `alg`+`key` carry the RS256->HS256 confusion case.
 */
async function signToken(
  over: {
    claims?: Record<string, unknown>;
    alg?: string;
    iss?: string;
    aud?: string | null;
    sub?: string | null;
    exp?: string | number;
    kid?: string;
    key?: CryptoKey | Uint8Array;
  } = {}
): Promise<string> {
  const jwt = new SignJWT(over.claims ?? { fhirUser: FHIR_USER }).setProtectedHeader({
    alg: over.alg ?? "RS256",
    kid: over.kid ?? KID_1
  });
  jwt.setIssuer(over.iss ?? ISSUER);
  if (over.aud !== null) jwt.setAudience(over.aud ?? AUDIENCE);
  if (over.sub !== null) jwt.setSubject(over.sub ?? SUBJECT);
  jwt.setExpirationTime(over.exp ?? "2h");
  return jwt.sign(over.key ?? key1.privateKey);
}

/** verifyToken must accept `token` and yield the verified identity. */
async function accepts(token: string): Promise<VerifiedIdentity> {
  const result = await verifyToken(token, CONFIG, jwks);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected ok, got err(${result.error.code})`);
  return result.data;
}

/** verifyToken must reject `token` with exactly `code` (fail-closed, never ok). */
async function rejects(token: string, code: AuthErrorCode): Promise<void> {
  const result = await verifyToken(token, CONFIG, jwks);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}

describe("verifyToken happy paths", () => {
  test("a legit RS256 token -> ok({iss,sub,fhirUser})", async () => {
    const id = await accepts(await signToken());
    expect(id.iss).toBe(ISSUER);
    expect(id.sub).toBe(SUBJECT);
    expect(id.fhirUser).toBe(FHIR_USER);
  });

  test("key rotation via the factory: a token signed by the second kid verifies", async () => {
    const token = await signToken({ kid: KID_2, key: key2.privateKey });
    const result = await createVerifier(CONFIG, jwks).verifyToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.sub).toBe(SUBJECT);
  });

  test("a token with no fhirUser claim verifies with fhirUser omitted", async () => {
    const id = await accepts(await signToken({ claims: {} }));
    expect(id.fhirUser).toBeUndefined();
  });
});

describe("verifyToken fail-closed controls (each err, never ok)", () => {
  test("alg:none is rejected by the allow-list", async () => {
    const token = new UnsecuredJWT({ fhirUser: FHIR_USER })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setExpirationTime("2h")
      .encode();
    await rejects(token, "ALG_NOT_ALLOWED");
  });

  test("an RS256 key re-signed as HS256 (alg confusion) is rejected", async () => {
    const hmacSecret = new TextEncoder().encode(await exportSPKI(key1.publicKey));
    await rejects(await signToken({ alg: "HS256", key: hmacSecret }), "ALG_NOT_ALLOWED");
  });

  test("a wrong issuer is rejected", async () => {
    await rejects(await signToken({ iss: "https://evil.synthetic.test/" }), "CLAIM_INVALID");
  });

  test("a wrong audience is rejected", async () => {
    await rejects(await signToken({ aud: "some-other-api" }), "CLAIM_INVALID");
  });

  test("an absent audience is rejected", async () => {
    await rejects(await signToken({ aud: null }), "CLAIM_INVALID");
  });

  test("an expired token is rejected", async () => {
    const past = Math.floor(Date.now() / 1000) - ONE_HOUR_SECONDS;
    await rejects(await signToken({ exp: past }), "TOKEN_EXPIRED");
  });

  test("an unknown kid is rejected (no JWKS match)", async () => {
    await rejects(await signToken({ kid: "kid-not-in-jwks" }), "JWKS_NO_MATCHING_KEY");
  });

  test("a verified token with no sub fails the claim-shape boundary", async () => {
    await rejects(await signToken({ sub: null }), "CLAIMS_SHAPE_INVALID");
  });

  test("a garbage string is rejected as malformed (never throws)", async () => {
    await rejects("this.is.not-a-jwt", "TOKEN_MALFORMED");
  });
});
