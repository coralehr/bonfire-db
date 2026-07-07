/**
 * The verified-identity boundary types (BF-13).
 *
 * `VerifiedIdentity` deliberately carries NO practice_id and NO role field: the
 * authorization scope is resolved SERVER-SIDE from the (iss,sub) membership row,
 * never from a token claim (claims-not-trusted, acceptance #4). Because the type
 * has no such field, code that tries to read a tenant/role off a verified token
 * is a COMPILE error — the claims-not-trusted invariant is structural here, not
 * merely a lint rule.
 */
import { z } from "zod";

/**
 * What a successful verification yields: the issuer + subject that key the
 * membership lookup, plus the optional SMART `fhirUser` identity claim (the
 * clinician/patient compartment principal). No authority attributes.
 */
export interface VerifiedIdentity {
  readonly iss: string;
  readonly sub: string;
  readonly fhirUser?: string;
}

/**
 * The output boundary schema: even though jose asserts `iss`, we re-parse the
 * shape we actually consume so a token that verifies but lacks a usable `sub`
 * (jose does not require one unless asked) fails closed as CLAIMS_SHAPE_INVALID
 * rather than producing an identity with an empty subject.
 */
export const verifiedClaimsSchema = z.object({
  iss: z.string().min(1),
  sub: z.string().min(1),
  fhirUser: z.string().min(1).optional()
});

/** The SMART identity claim name used when a config supplies no override. */
export const DEFAULT_FHIR_USER_CLAIM = "fhirUser";

/**
 * IdP-agnostic verifier configuration (BYO-IdP, acceptance #6). The `algorithms`
 * allow-list is the ONLY source of accepted algorithms — the token header's alg
 * is never trusted. `claimNames` lets a non-SMART IdP name its identity claim
 * differently while the code keeps speaking SMART (`fhirUser`) internally.
 */
export interface VerifyTokenConfig {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly audience: string;
  readonly algorithms: readonly string[];
  readonly clockToleranceSeconds: number;
  readonly claimNames?: { readonly fhirUser: string };
  /**
   * Optional per-deployment ceiling on token age (seconds). When set, a token
   * whose `iat` is older than this — even one minted with a far-future `exp` — is
   * rejected (TOKEN_EXPIRED), and `iat` becomes required. Caps the "long-lived
   * far-future-exp" residual; omit to defer age policy entirely to the IdP.
   */
  readonly maxTokenAgeSeconds?: number;
}
