/**
 * The typed authentication-failure vocabulary (BF-13). Every verification error
 * is one of these stable codes; callers branch on the code, never on a message,
 * and a denied verification NEVER throws across the boundary — verifyToken
 * catches every jose throw and returns `err(AuthError)` (fail-closed).
 *
 * The jose-code -> AuthErrorCode mapping is a Record with a `VERIFY_FAILED`
 * default (not a fat switch): an unmapped or unknown jose error still resolves
 * to a deny, so a new jose error variant can never fail open.
 */
import type { BonfireError } from "../result.js";

/**
 * ALG_NOT_ALLOWED       — token alg outside the configured positive allow-list
 *                         (alg:none, RS256->HS256 confusion) rejected pre-verify.
 * CLAIM_INVALID         — asserted iss/aud (or another registered claim) mismatch.
 * TOKEN_EXPIRED         — exp is in the past beyond the clock tolerance.
 * JWKS_NO_MATCHING_KEY  — the token's kid is absent from the JWKS.
 * SIGNATURE_INVALID     — the signature does not verify against the resolved key.
 * TOKEN_MALFORMED       — not a well-formed compact JWS/JWT.
 * CLAIMS_SHAPE_INVALID  — verified, but the required (iss,sub) claim shape failed
 *                         the Zod boundary (e.g. a missing/empty sub).
 * VERIFY_FAILED         — default: any other verification failure, fail-closed.
 */
export type AuthErrorCode =
  | "ALG_NOT_ALLOWED"
  | "CLAIM_INVALID"
  | "TOKEN_EXPIRED"
  | "JWKS_NO_MATCHING_KEY"
  | "SIGNATURE_INVALID"
  | "TOKEN_MALFORMED"
  | "CLAIMS_SHAPE_INVALID"
  | "VERIFY_FAILED";

export type AuthError = BonfireError<AuthErrorCode>;

/**
 * jose sets a stable string `code` on every error it throws. This maps the ones
 * BF-13 asserts to a typed AuthErrorCode; anything unmapped falls through to the
 * `VERIFY_FAILED` default in {@link mapJoseError}, so the boundary fails closed.
 */
const JOSE_CODE_TO_AUTH: Readonly<Record<string, AuthErrorCode>> = {
  ERR_JOSE_ALG_NOT_ALLOWED: "ALG_NOT_ALLOWED",
  ERR_JWT_CLAIM_VALIDATION_FAILED: "CLAIM_INVALID",
  ERR_JWT_EXPIRED: "TOKEN_EXPIRED",
  ERR_JWKS_NO_MATCHING_KEY: "JWKS_NO_MATCHING_KEY",
  ERR_JWKS_MULTIPLE_MATCHING_KEYS: "JWKS_NO_MATCHING_KEY",
  ERR_JWS_SIGNATURE_VERIFICATION_FAILED: "SIGNATURE_INVALID",
  ERR_JWS_INVALID: "TOKEN_MALFORMED",
  ERR_JWT_INVALID: "TOKEN_MALFORMED"
};

/** Stable, secret-free message per code (a Record keeps the mapping exhaustive). */
const AUTH_MESSAGE: Readonly<Record<AuthErrorCode, string>> = {
  ALG_NOT_ALLOWED: "token algorithm is not in the configured allow-list",
  CLAIM_INVALID: "a required token claim (iss/aud) did not validate",
  TOKEN_EXPIRED: "token is expired",
  JWKS_NO_MATCHING_KEY: "no JWKS key matches the token",
  SIGNATURE_INVALID: "token signature did not verify",
  TOKEN_MALFORMED: "token is malformed",
  CLAIMS_SHAPE_INVALID: "verified claims failed the required (iss,sub) shape",
  VERIFY_FAILED: "token verification failed"
};

/** Read jose's stable `.code` off an unknown thrown value (narrowing, no cast). */
function joseErrorCode(cause: unknown): string | undefined {
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const { code } = cause;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Build the typed AuthError for a code (used for both jose + Zod boundary fails). */
export function authError(code: AuthErrorCode): AuthError {
  return { code, message: AUTH_MESSAGE[code] };
}

/** Map any jose throw to a typed AuthError, defaulting to VERIFY_FAILED. */
export function mapJoseError(cause: unknown): AuthError {
  const joseCode = joseErrorCode(cause);
  const mapped = joseCode === undefined ? "VERIFY_FAILED" : JOSE_CODE_TO_AUTH[joseCode];
  return authError(mapped ?? "VERIFY_FAILED");
}
