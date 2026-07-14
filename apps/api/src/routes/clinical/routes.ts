/**
 * Authenticated clinical read surface. The caller supplies intent only; actor,
 * role, and Practice come exclusively from the verified membership bound by
 * `runAuthenticated`.
 */
import {
  buildCcp,
  err,
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_TOP_N,
  PURPOSES_OF_USE,
  type Subject,
  searchClinical,
  type TenantSql
} from "@bonfire/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AuthDeps } from "../../middleware/auth-hook.js";
import { runAuthenticated } from "../../middleware/auth-hook.js";

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;

const clinicalReadSchema = z.strictObject({
  query: z.string().min(1).max(MAX_SEARCH_QUERY_LENGTH),
  purposeOfUse: z.enum(PURPOSES_OF_USE),
  topN: z.number().int().min(1).max(MAX_SEARCH_TOP_N).optional()
});

type ClinicalRead = z.infer<typeof clinicalReadSchema>;

function subjectOf(context: {
  readonly actorId: string;
  readonly membership: { readonly practiceId: string; readonly role: Subject["role"] };
}): Subject {
  return {
    id: context.actorId,
    role: context.membership.role,
    practiceId: context.membership.practiceId
  };
}

function malformedRead() {
  return err({ code: "SEARCH_INVALID_INPUT" as const, message: "search request is malformed" });
}

function parseRead(request: FastifyRequest): ClinicalRead | undefined {
  const parsed = clinicalReadSchema.safeParse(request.body);
  return parsed.success ? parsed.data : undefined;
}

type ClinicalCall = (
  sql: TenantSql,
  subject: Subject,
  input: ClinicalRead,
  reply: FastifyReply
) => Promise<unknown>;

function clinicalHandler(deps: AuthDeps, call: ClinicalCall) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await runAuthenticated(request, reply, deps, async (context) => {
      const input = parseRead(request);
      if (input === undefined) {
        void reply.code(HTTP_BAD_REQUEST);
        return malformedRead();
      }
      return call(context.sql, subjectOf(context), input, reply);
    });
  };
}

/** Register the two public read routes behind the shared auth boundary. */
export function clinicalRoutes(deps: AuthDeps): (app: FastifyInstance) => Promise<void> {
  return (app: FastifyInstance): Promise<void> => {
    app.post(
      "/search",
      clinicalHandler(deps, (sql, subject, input) => searchClinical(sql, { ...input, subject }))
    );
    app.post(
      "/context",
      clinicalHandler(deps, async (sql, subject, input, reply) => {
        const searched = await searchClinical(sql, { ...input, subject });
        if (!searched.ok) return searched;
        if (searched.data.policyReceipt.decision !== "allow") {
          void reply.code(HTTP_FORBIDDEN);
          return err({
            code: "CONTEXT_FORBIDDEN" as const,
            message: "context request is not authorized"
          });
        }
        return buildCcp(sql, {
          response: searched.data,
          subject,
          purposeOfUse: input.purposeOfUse
        });
      })
    );
    return Promise.resolve();
  };
}
