/**
 * INTERNAL postgres.js client factory. Deliberately NOT exported from the
 * package entry point: `withTenant` (tenant.ts) is the only public query path,
 * so no caller can hold a connection that skips the tenant GUC.
 */
import type { Sql } from "postgres";
import postgres from "postgres";
import type { DatabaseTarget } from "./env.js";

export interface SqlClientOptions {
  /** Max pooled connections (postgres.js `max`). */
  readonly max?: number;
}

/** Create a lazily-connecting postgres.js client for the given target. */
export function createSqlClient(target: DatabaseTarget, options: SqlClientOptions = {}): Sql {
  const pool = options.max === undefined ? {} : { max: options.max };
  switch (target.kind) {
    case "url":
      return postgres(target.url, pool);
    case "parts":
      return postgres({
        ...pool,
        host: target.host,
        port: target.port,
        database: target.database,
        username: target.username,
        password: target.password
      });
  }
}
