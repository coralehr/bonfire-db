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
import type { VerifyTokenConfig } from "./types.js";
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

/** A fully-formed, signed RS256 token with the standard synthetic claims. */
function baseToken(kid: string): SignJWT {
  return new SignJWT({ fhirUser: FHIR_USER })
    .setProtectedHeader({ alg: "RS256", kid })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(SUBJECT)
    .setExpirationTime("2h");
}

describe("verifyToken happy paths", () => {
  test("a legit RS256 token -> ok({iss,sub,fhirUser})", async () => {
    const token = await baseToken(KID_1).sign(key1.privateKey);
    const result = await verifyToken(token, CONFIG, jwks);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.iss).toBe(ISSUER);
      expect(result.data.sub).toBe(SUBJECT);
      expect(result.data.fhirUser).toBe(FHIR_USER);
    }
  });

  test("key rotation: a token signed by the second kid still verifies", async () => {
    const token = await baseToken(KID_2).sign(key2.privateKey);
    const result = await createVerifier(CONFIG, jwks).verifyToken(token);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.sub).toBe(SUBJECT);
  });

  test("a token with no fhirUser claim verifies with fhirUser omitted", async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: KID_1 })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setExpirationTime("2h")
      .sign(key1.privateKey);
    const result = await verifyToken(token, CONFIG, jwks);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.fhirUser).toBeUndefined();
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
    const result = await verifyToken(token, CONFIG, jwks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ALG_NOT_ALLOWED");
  });

  test("an RS256 key re-signed as HS256 (alg confusion) is rejected", async () => {
    const spki = await exportSPKI(key1.publicKey);
    const hmacSecret = new TextEncoder().encode(spki);
    const token = await new SignJWT({ fhirUser: FHIR_USER })
      .setProtectedHeader({ alg: "HS256", kid: KID_1 })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setExpirationTime("2h")
      .sign(hmacSecret);
    const result = await verifyToken(token, CONFIG, jwks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ALG_NOT_ALLOWED");
  });

  test("a wrong issuer is rejected", async () => {
    const token = await new SignJWT({ fhirUser: FHIR_USER })
      .setProtectedHeader({ alg: "RS256", kid: KID_1 })
      .setIssuer("https://evil.synthetic.test/")
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setExpirationTime("2h")
      .sign(key1.privateKey);
    const result = await verifyToken(token, CONFIG, jwks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CLAIM_INVALID");
  });

  test("a wrong audience is rejected", async () => {
    const token = await new SignJWT({ fhirUser: FHIR_USER })
      .setProtectedHeader({ alg: "RS256", kid: KID_1 })
      .setIssuer(ISSUER)
      .setAudience("some-other-api")
      .setSubject(SUBJECT)
      .setExpirationTime("2h")
      .sign(key1.privateKey);
    const result = await verifyToken(token, CONFIG, jwks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CLAIM_INVALID");
  });

  test("an absent audience is rejected", async () => {
    const token = await new SignJWT({ fhirUser: FHIR_USER })
      .setProtectedHeader({ alg: "RS256", kid: KID_1 })
      .setIssuer(ISSUER)
      .setSubject(SUBJECT)
      .setExpirationTime("2h")
      .sign(key1.privateKey);
    const result = await verifyToken(token, CONFIG, jwks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CLAIM_INVALID");
  });

  test("an expired token is rejected", async () => {
    const past = Math.floor(Date.now() / 1000) - ONE_HOUR_SECONDS;
    const token = await new SignJWT({ fhirUser: FHIR_USER })
      .setProtectedHeader({ alg: "RS256", kid: KID_1 })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setExpirationTime(past)
      .sign(key1.privateKey);
    const result = await verifyToken(token, CONFIG, jwks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOKEN_EXPIRED");
  });

  test("an unknown kid is rejected (no JWKS match)", async () => {
    const token = await new SignJWT({ fhirUser: FHIR_USER })
      .setProtectedHeader({ alg: "RS256", kid: "kid-not-in-jwks" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setExpirationTime("2h")
      .sign(key1.privateKey);
    const result = await verifyToken(token, CONFIG, jwks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("JWKS_NO_MATCHING_KEY");
  });

  test("a verified token with no sub fails the claim-shape boundary", async () => {
    const token = await new SignJWT({ fhirUser: FHIR_USER })
      .setProtectedHeader({ alg: "RS256", kid: KID_1 })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setExpirationTime("2h")
      .sign(key1.privateKey);
    const result = await verifyToken(token, CONFIG, jwks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CLAIMS_SHAPE_INVALID");
  });

  test("a garbage string is rejected as malformed (never throws)", async () => {
    const result = await verifyToken("this.is.not-a-jwt", CONFIG, jwks);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TOKEN_MALFORMED");
  });
});
