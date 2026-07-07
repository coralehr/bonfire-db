/**
 * Production verifier wiring (BF-13). Composes the single OIDC adapter's config
 * with @bonfire/core's `createVerifier`, which builds a cached remote JWKS ONCE
 * and lazily (no network until the first verify). This is the ONLY place a prod
 * verifier is constructed; the middleware receives it by injection so tests can
 * supply a local, no-network key set instead.
 */
import type { BonfireError, EnvMap, Result, Verifier } from "@bonfire/core";
import { createVerifier } from "@bonfire/core";
import type { OidcConfigErrorCode } from "./oidc-config.js";
import { loadOidcConfig } from "./oidc-config.js";

/** Build the production verifier from the environment, or a typed config error. */
export function buildVerifier(
  env: EnvMap = process.env
): Result<Verifier, BonfireError<OidcConfigErrorCode>> {
  const config = loadOidcConfig(env);
  if (!config.ok) return config;
  return { ok: true, data: createVerifier(config.data) };
}
