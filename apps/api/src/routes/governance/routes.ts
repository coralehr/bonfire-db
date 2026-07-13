/**
 * BF-09 governance HTTP surface — the HUMAN path over the core store:
 * POST /governance/proposals            (propose)
 * POST /governance/proposals/:id/approve
 * POST /governance/proposals/:id/commit
 * There is NO reject route and NO read route (v0, per the locked design).
 *
 * The governance actor derives ONLY from the verified identity + membership
 * row (`runAuthenticated`); nothing identity- or authority-shaped is ever read
 * off the request body, params, headers, or token claims. Every route replies
 * 200 with the typed governance Result as the body — the body's stable error
 * codes (GOVERNANCE_FORBIDDEN / GOVERNANCE_INVALID_TRANSITION /
 * GOVERNANCE_NOT_FOUND / typed write errors) are the oracle, while
 * runAuthenticated owns the transport-level 401/403/500 denials.
 */
import type {
  GovernanceActor,
  GovernanceError,
  ProposalRecord,
  Result,
  SignedNote,
  TenantSql,
  WriteError
} from "@bonfire/core";
import { approveProposal, proposeRecord } from "@bonfire/core";
import type { ProjectedWriteError } from "@bonfire/sql-on-fhir";
import { commitProjectedProposal } from "@bonfire/sql-on-fhir";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthDeps } from "../../middleware/auth-hook.js";
import { runAuthenticated } from "../../middleware/auth-hook.js";

/** The proposal id in the URL is DATA, never authority. */
const paramsSchema = z.object({ id: z.uuid() });

/** The staged resource travels under one explicit key; extra keys are inert. */
const proposeBodySchema = z.looseObject({ resource: z.unknown() });

type GovernanceOutcome = Result<
  ProposalRecord | SignedNote,
  GovernanceError | WriteError | ProjectedWriteError
>;

/** One store call, bound to the authenticated actor + tenant-scoped sql. */
type GovernanceCall = (
  sql: TenantSql,
  actor: GovernanceActor,
  request: FastifyRequest
) => Promise<GovernanceOutcome>;

type GovernanceCommit = (
  sql: TenantSql,
  input: { readonly actor: unknown; readonly proposalId: string }
) => Promise<GovernanceOutcome>;

type RouteHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * A malformed URL id matches no proposal: the empty string resolves through
 * the store's own uuid check to a typed GOVERNANCE_NOT_FOUND (never a throw).
 */
function proposalIdOf(params: unknown): string {
  const parsed = paramsSchema.safeParse(params);
  return parsed.success ? parsed.data.id : "";
}

/**
 * A missing/malformed body yields `undefined`, which fails the scribe schema
 * inside the store as a typed INVALID_SCRIBE_INPUT — one validator, one path.
 */
function stagedResourceOf(body: unknown): unknown {
  const parsed = proposeBodySchema.safeParse(body);
  return parsed.success ? parsed.data.resource : undefined;
}

/**
 * The ONE handler factory: authenticate, derive the governance actor from the
 * verified identity + membership row ONLY, run the store call inside the
 * membership-resolved tenant transaction, and let runAuthenticated reply 200
 * with the typed Result body (or 401/403/500 on transport-level denial).
 */
function governanceHandler(deps: AuthDeps, call: GovernanceCall): RouteHandler {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await runAuthenticated(request, reply, deps, (ctx) =>
      call(
        ctx.sql,
        {
          id: `${ctx.identity.iss}#${ctx.identity.sub}`,
          role: ctx.membership.role,
          practiceId: ctx.membership.practiceId
        },
        request
      )
    );
  };
}

/** Fastify plugin factory over injected deps (BF-13 pattern; app wiring stays deferred). */
export function governanceRoutes(
  deps: AuthDeps,
  commit: GovernanceCommit = commitProjectedProposal
): (app: FastifyInstance) => Promise<void> {
  return (app: FastifyInstance): Promise<void> => {
    app.post(
      "/governance/proposals",
      governanceHandler(deps, (sql, actor, request) =>
        proposeRecord(sql, { actor, resource: stagedResourceOf(request.body) })
      )
    );
    app.post(
      "/governance/proposals/:id/approve",
      governanceHandler(deps, (sql, actor, request) =>
        approveProposal(sql, { actor, proposalId: proposalIdOf(request.params) })
      )
    );
    app.post(
      "/governance/proposals/:id/commit",
      governanceHandler(deps, (sql, actor, request) =>
        commit(sql, { actor, proposalId: proposalIdOf(request.params) })
      )
    );
    return Promise.resolve();
  };
}
