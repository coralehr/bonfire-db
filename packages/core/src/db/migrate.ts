/**
 * Forward-only migration runner (drizzle-orm programmatic migrator over the
 * drizzle/ journal). Migrations are a DEPLOY step executed as the migration
 * owner via MIGRATE_DATABASE_URL — the runtime role `bonfire_app` never gets
 * DDL and the app never connects with this URL.
 *
 * Invoked as `bun run db:migrate` (root script) or imported as runMigrations.
 */
import { pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { BonfireError, Result } from "../result.js";
import { err, ok } from "../result.js";
import { devDatabaseUrl } from "./env.js";

export type MigrateErrorCode = "MIGRATION_FAILED";

const END_TIMEOUT_SECONDS = 5;

/** Apply all pending migrations from drizzle/; idempotent (re-run is a no-op). */
export async function runMigrations(
  databaseUrl?: string
): Promise<Result<{ readonly applied: true }, BonfireError<MigrateErrorCode>>> {
  const url = databaseUrl ?? process.env.MIGRATE_DATABASE_URL ?? devDatabaseUrl("migrate");
  const sql = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(sql), { migrationsFolder: "drizzle" });
    return ok({ applied: true });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "unknown failure";
    return err({ code: "MIGRATION_FAILED", message: `migration run failed: ${detail}` });
  } finally {
    await sql.end({ timeout: END_TIMEOUT_SECONDS });
  }
}

function isDirectRun(): boolean {
  const script = process.argv[1];
  return script !== undefined && pathToFileURL(script).href === import.meta.url;
}

if (isDirectRun()) {
  const result = await runMigrations();
  if (result.ok) {
    process.stdout.write("db:migrate ok\n");
  } else {
    process.stderr.write(`db:migrate failed [${result.error.code}]: ${result.error.message}\n`);
    process.exitCode = 1;
  }
}
