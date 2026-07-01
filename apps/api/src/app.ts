/**
 * Fastify app factory. The api owns a small non-tenant postgres pool used ONLY
 * by the /health catalog probe (it connects as bonfire_app like everything
 * else); all tenant-scoped data access goes through @bonfire/core withTenant.
 */
import { resolveDatabaseTarget } from "@bonfire/core";
import type {
  FastifyBaseLogger,
  FastifyInstance,
  RawReplyDefaultExpression,
  RawRequestDefaultExpression,
  RawServerDefault
} from "fastify";
import fastify from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { Sql } from "postgres";
import postgres from "postgres";
import { healthRoutes } from "./health.js";

const POOL_MAX = 4;
const CONNECT_TIMEOUT_SECONDS = 5;
const IDLE_TIMEOUT_SECONDS = 20;
const SQL_END_TIMEOUT_SECONDS = 5;

function createHealthSql(databaseUrl?: string): Sql {
  const pool = {
    max: POOL_MAX,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
    idle_timeout: IDLE_TIMEOUT_SECONDS
  };
  if (databaseUrl !== undefined) {
    return postgres(databaseUrl, pool);
  }
  const target = resolveDatabaseTarget();
  if (target.kind === "url") {
    return postgres(target.url, pool);
  }
  const { host, port, database, username, password } = target;
  return postgres({ ...pool, host, port, database, username, password });
}

/**
 * Build the api. Callers own the lifecycle: `app.close()` also ends the pool.
 * `databaseUrl` overrides the DB target (tests point it at a dead port);
 * `logger` enables request logging (the server entry turns it on).
 */
export function buildApp(
  options: { readonly databaseUrl?: string; readonly logger?: boolean } = {}
): FastifyInstance<
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
  FastifyBaseLogger,
  ZodTypeProvider
> {
  const sql = createHealthSql(options.databaseUrl);
  const app = fastify({
    logger: options.logger ?? false,
    forceCloseConnections: "idle"
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  void app.register(healthRoutes, { sql });
  app.addHook("onClose", async () => {
    await sql.end({ timeout: SQL_END_TIMEOUT_SECONDS });
  });
  return app;
}
