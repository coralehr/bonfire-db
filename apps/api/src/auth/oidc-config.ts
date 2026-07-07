/**
 * BYO-IdP configuration adapter (BF-13, acceptance #6). ONE OIDC adapter ships
 * in v0: it reads issuer + JWKS URL + audience + the identity claim name from the
 * environment (Zod-parsed, fail-closed) and produces the IdP-agnostic
 * `VerifyTokenConfig` that @bonfire/core's verifier consumes. No auth-vendor SDK
 * is bundled — we CONSUME verified identity, we do not run an authorization
 * server. The identity claim defaults to the SMART `fhirUser` name, so SMART is a
 * later additive adapter rather than a rewrite; the SMART authorization-server
 * endpoints (authorize/token/.well-known/smart-configuration) are deliberately
 * NOT implemented (deferred).
 */
import type { BonfireError, EnvMap, Result, VerifyTokenConfig } from "@bonfire/core";
import { DEFAULT_FHIR_USER_CLAIM, err, ok } from "@bonfire/core";
import { z } from "zod";

/** The positive algorithm allow-list; the token header's alg is never trusted. */
const SUPPORTED_ALGORITHMS = ["RS256", "ES256", "EdDSA"] as const;
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;

export type OidcConfigErrorCode = "OIDC_CONFIG_INVALID";

/**
 * The env boundary (parse, don't validate). A missing/garbage issuer, JWKS URL,
 * or audience is a deploy-time misconfiguration that must fail closed — never a
 * verifier that silently accepts tokens from an unintended issuer.
 */
const oidcEnvSchema = z.object({
  OIDC_ISSUER: z.url(),
  OIDC_JWKS_URI: z.url(),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_FHIR_USER_CLAIM: z.string().min(1).default(DEFAULT_FHIR_USER_CLAIM),
  OIDC_CLOCK_TOLERANCE_SECONDS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(DEFAULT_CLOCK_TOLERANCE_SECONDS)
});

/** Resolve the single v0 OIDC adapter's `VerifyTokenConfig` from the environment. */
export function loadOidcConfig(
  env: EnvMap = process.env
): Result<VerifyTokenConfig, BonfireError<OidcConfigErrorCode>> {
  const parsed = oidcEnvSchema.safeParse(env);
  if (!parsed.success) {
    return err({ code: "OIDC_CONFIG_INVALID", message: "OIDC verifier configuration is invalid" });
  }
  const e = parsed.data;
  return ok({
    issuer: e.OIDC_ISSUER,
    jwksUri: e.OIDC_JWKS_URI,
    audience: e.OIDC_AUDIENCE,
    algorithms: SUPPORTED_ALGORITHMS,
    clockToleranceSeconds: e.OIDC_CLOCK_TOLERANCE_SECONDS,
    claimNames: { fhirUser: e.OIDC_FHIR_USER_CLAIM }
  });
}
