/**
 * The SDK identity boundary (security unit U2): `authenticate` is the ONLY
 * constructor of tenant scope. It verifies the token through the injected
 * BF-13 verifier, resolves (iss, sub) to a membership row SERVER-SIDE
 * (claims-not-trusted — practice/role NEVER come from token claims or caller
 * input), audits the decision on the BF-05 hash chain, and returns a
 * `BonfireSession` whose class value is never exported, so no code outside
 * this module can mint a session or name its own practice/role.
 *
 * Session authority is point-in-time: it snapshots the membership row at
 * authentication time; there is no refresh loop — re-authenticate to
 * re-resolve authority.
 */
import type {
  AuthFailure,
  BonfireError,
  Membership,
  Result,
  Role,
  TenantDb,
  VerifiedIdentity,
  Verifier,
  VerifyTokenConfig
} from "@bonfire/core";
import { auditAuthFailure, auditAuthSuccess, createVerifier, err, ok } from "@bonfire/core";

/** Stable codes for every way authentication can fail. Each one is a deny. */
export type AuthenticateErrorCode =
  | "AUTH_VERIFY_FAILED"
  | "AUTH_MEMBERSHIP_LOOKUP_FAILED"
  | "AUTH_NO_MEMBERSHIP"
  | "AUTH_AUDIT_FAILED";

/**
 * Verifier config the SDK accepts: unlike core's `VerifyTokenConfig`, the
 * token-age ceiling is REQUIRED — an SDK consumer must state it explicitly
 * (a far-future-exp token cannot outlive the deployment's stated ceiling).
 */
export interface SessionVerifyConfig extends VerifyTokenConfig {
  readonly maxTokenAgeSeconds: number;
}

/** Key-set injection passthrough (tests verify against a local JWKS, offline). */
export type VerifierKeySet = Parameters<typeof createVerifier>[1];

/** Build a fail-closed verifier whose token-age ceiling is mandatory. */
export function createSessionVerifier(
  config: SessionVerifyConfig,
  keySet?: VerifierKeySet
): Verifier {
  return createVerifier(config, keySet);
}

/**
 * A verified, membership-backed tenant scope. Only the TYPE is exported: the
 * #private field makes it nominal (no structural literal can pose as one) and
 * the class value stays module-private, so `authenticate` is the single
 * construction path. There is deliberately NO deserializer — a JSON
 * round-trip decays into a plain object that no longer satisfies the type,
 * which is the SAFE failure.
 */
class BonfireSession {
  readonly #practiceId: string;
  readonly iss: string;
  readonly sub: string;
  readonly role: Role;

  constructor(identity: VerifiedIdentity, membership: Membership) {
    this.iss = identity.iss;
    this.sub = identity.sub;
    this.role = membership.role;
    this.#practiceId = membership.practiceId;
  }

  /** The membership-resolved tenant — never a token claim, never caller input. */
  get practiceId(): string {
    return this.#practiceId;
  }

  /** The audited actor identity, composed exactly like core's auth audit rows. */
  get actorId(): string {
    return `${this.iss}#${this.sub}`;
  }
}

export type { BonfireSession };

/** Everything `authenticate` needs; the verifier is injected (BYO-IdP). */
export interface AuthenticateDeps {
  readonly db: TenantDb;
  readonly verifier: Verifier;
  readonly token: string;
}

/** The typed deny `authenticate` returns on every failure path. */
export type AuthenticateError = BonfireError<AuthenticateErrorCode>;

/** Audit the deny on the SYSTEM chain, then return the stable-code error. */
async function denyAudited(
  db: TenantDb,
  failure: AuthFailure,
  code: AuthenticateErrorCode,
  message: string
): Promise<Result<never, AuthenticateError>> {
  const audited = await auditAuthFailure(db, failure);
  // The deny stands regardless; a failed deny-audit is surfaced in the message
  // so a missing forensic row is observable rather than silent.
  return err({ code, message: audited.ok ? message : `${message} (deny-audit append failed)` });
}

/**
 * verifyToken -> resolveMembership -> audit -> session. Every non-ok branch
 * returns a typed deny with a stable code; nothing throws across the boundary,
 * and no failure path ever yields a session.
 */
export async function authenticate(
  deps: AuthenticateDeps
): Promise<Result<BonfireSession, AuthenticateError>> {
  const verified = await deps.verifier.verifyToken(deps.token);
  if (!verified.ok) {
    const failure: AuthFailure = { kind: "verify", code: verified.error.code };
    return denyAudited(deps.db, failure, "AUTH_VERIFY_FAILED", "token verification failed");
  }
  const identity = verified.data;
  const membership = await deps.db.resolveMembership(identity.iss, identity.sub);
  if (!membership.ok) {
    const failure: AuthFailure = { kind: "no-membership", identity };
    return denyAudited(
      deps.db,
      failure,
      "AUTH_MEMBERSHIP_LOOKUP_FAILED",
      "membership lookup failed"
    );
  }
  if (membership.data === null) {
    const failure: AuthFailure = { kind: "no-membership", identity };
    return denyAudited(deps.db, failure, "AUTH_NO_MEMBERSHIP", "identity has no membership");
  }
  const audited = await auditAuthSuccess(deps.db, identity, membership.data);
  if (!audited.ok) {
    return err({ code: "AUTH_AUDIT_FAILED", message: "authentication audit append failed" });
  }
  return ok(new BonfireSession(identity, membership.data));
}
