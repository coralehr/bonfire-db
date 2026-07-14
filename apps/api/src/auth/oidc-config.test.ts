/**
 * TRACER C — the single OIDC config adapter + production verifier construction.
 *
 * No DB and no network: `createVerifier` builds its remote JWKS lazily, so
 * constructing the prod verifier here never reaches out. Also asserts the SMART
 * identity claim (`fhirUser`) is the default and that no auth-vendor SDK is a
 * dependency (we consume verified identity; we are not an OAuth server).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { loadOidcConfig } from "./oidc-config.js";
import { buildVerifier } from "./verifier.js";

const VALID_ENV = {
  OIDC_ISSUER: "https://idp.synthetic.test/",
  OIDC_JWKS_URI: "https://idp.synthetic.test/.well-known/jwks.json",
  OIDC_AUDIENCE: "bonfire-api"
};

const AUTH_VENDOR_SDKS = [
  "openid-client",
  "passport",
  "jsonwebtoken",
  "next-auth",
  "@auth0/auth0-spa-js",
  "@okta/jwt-verifier",
  "@clerk/backend",
  "firebase-admin"
];

describe("loadOidcConfig parses BYO-IdP settings from the environment", () => {
  test("a valid env yields a VerifyTokenConfig with the SMART fhirUser claim", () => {
    const result = loadOidcConfig(VALID_ENV);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.issuer).toBe(VALID_ENV.OIDC_ISSUER);
      expect(result.data.jwksUri).toBe(VALID_ENV.OIDC_JWKS_URI);
      expect(result.data.audience).toBe(VALID_ENV.OIDC_AUDIENCE);
      expect(result.data.algorithms).toEqual(["RS256", "ES256", "EdDSA"]);
      expect(result.data.claimNames?.fhirUser).toBe("fhirUser");
      expect(result.data.clockToleranceSeconds).toBe(60);
    }
  });

  test("a non-SMART IdP can override the identity claim name", () => {
    const result = loadOidcConfig({ ...VALID_ENV, OIDC_FHIR_USER_CLAIM: "smart_fhir_user" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.claimNames?.fhirUser).toBe("smart_fhir_user");
  });

  test("a missing issuer fails closed (OIDC_CONFIG_INVALID)", () => {
    const result = loadOidcConfig({
      OIDC_JWKS_URI: VALID_ENV.OIDC_JWKS_URI,
      OIDC_AUDIENCE: VALID_ENV.OIDC_AUDIENCE
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OIDC_CONFIG_INVALID");
  });

  test("a non-URL issuer fails closed", () => {
    const result = loadOidcConfig({ ...VALID_ENV, OIDC_ISSUER: "not-a-url" });
    expect(result.ok).toBe(false);
  });

  test("plaintext HTTP issuer or JWKS endpoints fail closed", () => {
    for (const env of [
      { ...VALID_ENV, OIDC_ISSUER: "http://idp.synthetic.test/" },
      { ...VALID_ENV, OIDC_JWKS_URI: "http://idp.synthetic.test/jwks.json" }
    ]) {
      const result = loadOidcConfig(env);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("OIDC_CONFIG_INVALID");
    }
  });

  test("issuer query strings and fragments fail closed", () => {
    for (const issuer of [
      "https://idp.synthetic.test/?tenant=other",
      "https://idp.synthetic.test/#other"
    ]) {
      expect(loadOidcConfig({ ...VALID_ENV, OIDC_ISSUER: issuer }).ok).toBe(false);
    }
  });

  test("clock tolerance is bounded to five minutes", () => {
    const maximum = loadOidcConfig({ ...VALID_ENV, OIDC_CLOCK_TOLERANCE_SECONDS: "300" });
    expect(maximum.ok).toBe(true);
    if (maximum.ok) expect(maximum.data.clockToleranceSeconds).toBe(300);

    const excessive = loadOidcConfig({ ...VALID_ENV, OIDC_CLOCK_TOLERANCE_SECONDS: "301" });
    expect(excessive.ok).toBe(false);
  });
});

describe("buildVerifier constructs a prod verifier with no network", () => {
  test("a valid env yields a Verifier whose JWKS is lazy (no fetch at build)", () => {
    const result = buildVerifier(VALID_ENV);
    expect(result.ok).toBe(true);
    if (result.ok) expect(typeof result.data.verifyToken).toBe("function");
  });

  test("an invalid env yields a typed config error, not a verifier", () => {
    const result = buildVerifier({ OIDC_AUDIENCE: "only-audience" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("OIDC_CONFIG_INVALID");
  });
});

describe("no auth-vendor SDK is bundled (we consume identity, not issue it)", () => {
  test("apps/api declares no OAuth/OIDC vendor SDK dependency", () => {
    const pkgUrl = new URL("../../package.json", import.meta.url);
    const pkg: unknown = JSON.parse(readFileSync(pkgUrl, "utf8"));
    const deps = collectDependencyNames(pkg);
    for (const vendor of AUTH_VENDOR_SDKS) {
      expect(deps).not.toContain(vendor);
    }
  });
});

function collectDependencyNames(pkg: unknown): string[] {
  if (typeof pkg !== "object" || pkg === null) return [];
  const names: string[] = [];
  for (const field of ["dependencies", "devDependencies"]) {
    const block = (pkg as Record<string, unknown>)[field];
    if (typeof block === "object" && block !== null) {
      names.push(...Object.keys(block));
    }
  }
  return names;
}
