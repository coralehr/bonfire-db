/**
 * GET /health — typed Result at the boundary, fail-closed, hard timeout.
 *
 * The probe is ONE round-trip against catalog state only (pg_extension); it
 * never touches migrated tables because compose health-checks the api BEFORE
 * `bun run db:migrate` runs. It never hangs (2s ceiling with query.cancel())
 * and never leaks err.message/stack/query text — unhealthy responses carry an
 * opaque stable code only.
 */
import type { BonfireError, Result } from "@bonfire/core";
import { err, ok } from "@bonfire/core";
import type { FastifyPluginCallbackZod } from "fastify-type-provider-zod";
import type { Sql } from "postgres";
import { z } from "zod";

type HealthErrorCode =
  | "DB_UNAVAILABLE"
  | "DB_CONNECT_TIMEOUT"
  | "HEALTH_TIMEOUT"
  | "PGVECTOR_MISSING";

const HEALTH_TIMEOUT_MS = 2000;
const HTTP_OK = 200;
const HTTP_SERVICE_UNAVAILABLE = 503;

const healthOkSchema = z.object({
  ok: z.literal(true),
  db: z.literal("up"),
  pgvector: z.literal("present"),
  pgvectorVersion: z.string(),
  latencyMs: z.number().nonnegative()
});

const healthErrSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.enum(["DB_UNAVAILABLE", "DB_CONNECT_TIMEOUT", "HEALTH_TIMEOUT", "PGVECTOR_MISSING"])
  })
});

type HealthOkBody = z.infer<typeof healthOkSchema>;

interface ProbeSuccess {
  readonly pgvectorVersion: string;
}

function isConnectTimeout(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "CONNECT_TIMEOUT"
  );
}

async function probeDatabase(
  sql: Sql
): Promise<Result<ProbeSuccess, BonfireError<HealthErrorCode>>> {
  const query = sql<{ ok: number; vector: string | null }[]>`
    select 1 as ok, (select extversion from pg_extension where extname = 'vector') as vector`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      query.cancel();
      resolve("timeout");
    }, HEALTH_TIMEOUT_MS);
    timer.unref();
  });
  try {
    const raced = await Promise.race([query, timedOut]);
    if (raced === "timeout") {
      return err({ code: "HEALTH_TIMEOUT", message: "health probe exceeded its deadline" });
    }
    const row = raced[0];
    if (row === undefined) {
      return err({ code: "DB_UNAVAILABLE", message: "health probe returned no row" });
    }
    if (row.vector === null) {
      return err({ code: "PGVECTOR_MISSING", message: "pgvector extension is not installed" });
    }
    return ok({ pgvectorVersion: row.vector });
  } catch (cause) {
    if (isConnectTimeout(cause)) {
      return err({ code: "DB_CONNECT_TIMEOUT", message: "database connection timed out" });
    }
    return err({ code: "DB_UNAVAILABLE", message: "database is unreachable" });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export const healthRoutes: FastifyPluginCallbackZod<{ sql: Sql }> = (app, opts, done) => {
  app.get(
    "/health",
    {
      schema: {
        response: { [HTTP_OK]: healthOkSchema, [HTTP_SERVICE_UNAVAILABLE]: healthErrSchema }
      }
    },
    async (_request, reply) => {
      const startedAt = Date.now();
      const probed = await probeDatabase(opts.sql);
      if (!probed.ok) {
        // Opaque code only — never the underlying error message/stack/query.
        return reply
          .code(HTTP_SERVICE_UNAVAILABLE)
          .send({ ok: false, error: { code: probed.error.code } });
      }
      const body: HealthOkBody = {
        ok: true,
        db: "up",
        pgvector: "present",
        pgvectorVersion: probed.data.pgvectorVersion,
        latencyMs: Date.now() - startedAt
      };
      return reply.code(HTTP_OK).send(body);
    }
  );
  done();
};
