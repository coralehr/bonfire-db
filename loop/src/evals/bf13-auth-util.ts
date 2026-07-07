/**
 * Shared scaffolding for the BF-13 Stage-2 evals. Forges SYNTHETIC tokens with
 * jose (a root dep — NOT product code, so the harness<->product firewall holds)
 * and shells out to scripts/auth-demo/authenticate.ts, which runs the real
 * @bonfire/core auth path. The eval asserts on the returned outcome, so the
 * check exercises a genuine build of the product across the firewall.
 *
 * The `alg` a token is SIGNED with is attacker-chosen (alg:none, HS256 forged
 * from the RSA public key); the product's positive allow-list is what must
 * reject them. All keys are generated in-process and never persisted.
 */

import type { JSONWebKeySet } from "jose";
import { exportJWK, exportSPKI, generateKeyPair, SignJWT, UnsecuredJWT } from "jose";
import { fail, lastJsonLine, runArtifact } from "./eval-util.js";

const keyId = "bf13-eval-key";
const algorithms = ["RS256", "ES256", "EdDSA"] as const;
const clockToleranceSeconds = 5;
const fhirUserClaim = "https://fhir.bf13-eval.test/Practitioner/eval";
const defaultExpiry = "2h";
const ONE_HOUR_SECONDS = 3600;
const MILLIS_PER_SECOND = 1000;

/** The eval's synthetic IdP identity — evals seed membership under this issuer. */
export const issuer = "https://idp.bf13-eval.test/";
export const audience = "bonfire-eval-api";

/** jose's private-key type, inferred so no DOM `CryptoKey` global is required. */
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

export interface Keys {
  readonly privateKey: PrivateKey;
  readonly jwks: JSONWebKeySet;
  readonly spkiPem: string;
}

export interface TokenConfig {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly audience: string;
  readonly algorithms: readonly string[];
  readonly clockToleranceSeconds: number;
  readonly claimNames?: { readonly fhirUser: string };
}

export interface SignOptions {
  readonly sub?: string;
  readonly iss?: string;
  readonly aud?: string;
  readonly expiresIn?: string | number;
  readonly omitExp?: boolean;
  readonly claims?: Record<string, unknown>;
}

export interface AuthJob {
  readonly token: string;
  readonly jwks: JSONWebKeySet;
  readonly config: TokenConfig;
  readonly resolve: boolean;
  readonly audit: boolean;
}

export interface AuthOutcome {
  readonly verify:
    | { readonly ok: true; readonly identity: { iss: string; sub: string; fhirUser?: string } }
    | { readonly ok: false; readonly code: string };
  readonly membership:
    | null
    | "none"
    | { readonly practiceId: string; readonly role: string }
    | { readonly error: string };
  readonly audit:
    | null
    | { readonly decision: string; readonly auditRowHash: string; readonly practiceId?: string }
    | { readonly error: string };
}

/** Generate a one-off RS256 keypair + its public JWKS and SPKI PEM (for HS256). */
export async function mintKeys(): Promise<Keys> {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const spkiPem = await exportSPKI(publicKey);
  return {
    privateKey,
    jwks: { keys: [{ ...jwk, kid: keyId, alg: "RS256", use: "sig" }] },
    spkiPem
  };
}

function baseJwt(opts: SignOptions): SignJWT {
  return new SignJWT({ fhirUser: fhirUserClaim, ...opts.claims })
    .setIssuer(opts.iss ?? issuer)
    .setAudience(opts.aud ?? audience)
    .setSubject(opts.sub ?? crypto.randomUUID());
}

/** A legitimately RS256-signed token (override iss/aud/exp/claims to break it). */
export async function signRs256(keys: Keys, opts: SignOptions = {}): Promise<string> {
  const header = baseJwt(opts).setProtectedHeader({ alg: "RS256", kid: keyId });
  const withExp =
    opts.omitExp === true ? header : header.setExpirationTime(opts.expiresIn ?? defaultExpiry);
  return withExp.sign(keys.privateKey);
}

/** An `alg:none` unsecured token — must be rejected by the allow-list. */
export function signAlgNone(opts: SignOptions = {}): string {
  return new UnsecuredJWT({ fhirUser: fhirUserClaim, ...opts.claims })
    .setIssuer(opts.iss ?? issuer)
    .setAudience(opts.aud ?? audience)
    .setSubject(opts.sub ?? crypto.randomUUID())
    .setExpirationTime(opts.expiresIn ?? defaultExpiry)
    .encode();
}

/** Algorithm-confusion: HS256 signed with the RSA PUBLIC key as the HMAC secret. */
export async function signHs256Confusion(keys: Keys, opts: SignOptions = {}): Promise<string> {
  const secret = new TextEncoder().encode(keys.spkiPem);
  return baseJwt(opts)
    .setProtectedHeader({ alg: "HS256", kid: keyId })
    .setExpirationTime(opts.expiresIn ?? defaultExpiry)
    .sign(secret);
}

/** A past epoch-seconds expiry (an expired token). */
export function expiredExp(): number {
  return Math.floor(Date.now() / MILLIS_PER_SECOND) - ONE_HOUR_SECONDS;
}

/** The VerifyTokenConfig the eval hands the product (override to break a field). */
export function buildConfig(overrides: Partial<TokenConfig> = {}): TokenConfig {
  return {
    issuer,
    jwksUri: `${issuer}.well-known/jwks.json`,
    audience,
    algorithms: [...algorithms],
    clockToleranceSeconds,
    ...overrides
  };
}

/** Assemble an authenticate.ts job (verify-only by default). */
export function authJob(params: {
  readonly token: string;
  readonly jwks: JSONWebKeySet;
  readonly config?: TokenConfig;
  readonly resolve?: boolean;
  readonly audit?: boolean;
}): AuthJob {
  return {
    token: params.token,
    jwks: params.jwks,
    config: params.config ?? buildConfig(),
    resolve: params.resolve ?? false,
    audit: params.audit ?? false
  };
}

/** Run the product auth path for `job` and return its structured outcome. */
export function runAuthenticate(evalId: string, job: AuthJob): AuthOutcome {
  const run = runArtifact(evalId, [
    "bun",
    "scripts/auth-demo/authenticate.ts",
    JSON.stringify(job)
  ]);
  if (run.status !== 0) {
    fail(evalId, `authenticate.ts exited ${String(run.status)}:\n${run.output}`);
  }
  return lastJsonLine(evalId, run.output) as AuthOutcome;
}
