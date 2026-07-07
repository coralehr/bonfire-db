/**
 * `runAuthenticated` — the injectable per-request authentication boundary (BF-13).
 *
 * Flow (fail-closed at every step; the alg/iss/aud/exp checks live in the
 * injected verifier):
 *   1. Extract a Bearer token (undefined OR string[] header -> deny, audited).
 *   2. Verify it (any verifier error -> 401, audited under SYSTEM).
 *   3. Resolve (iss,sub) -> membership server-side (no membership -> 403,
 *      audited under SYSTEM). practice_id/role come ONLY from the membership row.
 *   4. Audit the SUCCESS on the resolved practice's chain in its OWN committed
 *      transaction, THEN run the handler inside a SEPARATE `withTenant` tx. A
 *      throwing handler rolls back only its own tx — the authentication record
 *      survives (auth is not conditional on the request succeeding).
 *
 * It is shipped as an injectable function (verifier + tenantDb passed in), NOT
 * wired into the live server here — production wiring of app.ts/server.ts is
 * deferred (see ADR 0003). Tests construct a local Fastify app around it.
 */
import type {
  AuthErrorCode,
  AuthFailure,
  Membership,
  TenantDb,
  TenantSql,
  VerifiedIdentity,
  Verifier
} from "@bonfire/core";
import { auditAuthFailure, auditAuthSuccess } from "@bonfire/core";
import type { FastifyReply, FastifyRequest } from "fastify";

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_INTERNAL_ERROR = 500;
const BEARER_PREFIX = "Bearer ";

/** Everything the boundary needs, injected so tests supply no-network doubles. */
export interface AuthDeps {
  readonly verifier: Verifier;
  readonly tenantDb: TenantDb;
}

/** The tenant-scoped context handed to an authenticated handler (internal:
 *  reached only through the exported AuthenticatedHandler signature). */
interface AuthenticatedContext {
  readonly identity: VerifiedIdentity;
  readonly membership: Membership;
  readonly sql: TenantSql;
}

export type AuthenticatedHandler<T> = (ctx: AuthenticatedContext) => Promise<T>;

/** Read a Bearer token fail-closed: a non-string header (absent/array) denies. */
function bearerToken(header: string | readonly string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  if (!header.startsWith(BEARER_PREFIX)) return undefined;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : undefined;
}

function sendError(reply: FastifyReply, status: number, code: string): void {
  void reply.code(status).send({ ok: false, error: { code } });
}

/** Audit a failed auth on the SYSTEM chain, then send the deny (fail-closed). */
async function denyAudited(
  reply: FastifyReply,
  deps: AuthDeps,
  status: number,
  responseCode: string,
  failure: AuthFailure
): Promise<void> {
  await auditAuthFailure(deps.tenantDb, failure);
  sendError(reply, status, responseCode);
}

async function runWithTenant<T>(
  reply: FastifyReply,
  deps: AuthDeps,
  identity: VerifiedIdentity,
  membership: Membership,
  handler: AuthenticatedHandler<T>
): Promise<void> {
  // Success audit commits in its OWN tx BEFORE the handler runs, so a throwing
  // handler cannot roll back the authentication record.
  const audited = await auditAuthSuccess(deps.tenantDb, identity, membership);
  if (!audited.ok) {
    sendError(reply, HTTP_INTERNAL_ERROR, "AUTH_AUDIT_FAILED");
    return;
  }
  const outcome = await deps.tenantDb.withTenant(membership.practiceId, (sql) =>
    handler({ identity, membership, sql })
  );
  if (!outcome.ok) {
    sendError(reply, HTTP_INTERNAL_ERROR, "HANDLER_FAILED");
    return;
  }
  void reply.code(HTTP_OK).send(outcome.data);
}

/**
 * Authenticate the request, resolve its tenant, and run `handler` scoped to that
 * tenant. Emits exactly one audit row per request (a deny under SYSTEM, a success
 * under the resolved practice). Returns void; the reply is sent internally.
 */
export async function runAuthenticated<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AuthDeps,
  handler: AuthenticatedHandler<T>
): Promise<void> {
  const token = bearerToken(request.headers.authorization);
  if (token === undefined) {
    const failure: AuthFailure = { kind: "verify", code: "TOKEN_MALFORMED" };
    return denyAudited(reply, deps, HTTP_UNAUTHORIZED, "UNAUTHENTICATED", failure);
  }
  const verified = await deps.verifier.verifyToken(token);
  if (!verified.ok) {
    const code: AuthErrorCode = verified.error.code;
    const failure: AuthFailure = { kind: "verify", code };
    return denyAudited(reply, deps, HTTP_UNAUTHORIZED, "UNAUTHENTICATED", failure);
  }
  const identity = verified.data;
  const membership = await deps.tenantDb.resolveMembership(identity.iss, identity.sub);
  if (!membership.ok || membership.data === null) {
    const failure: AuthFailure = { kind: "no-membership", identity };
    return denyAudited(reply, deps, HTTP_FORBIDDEN, "FORBIDDEN", failure);
  }
  return runWithTenant(reply, deps, identity, membership.data, handler);
}
