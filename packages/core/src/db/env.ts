/**
 * Database connection target resolution (boundary input -> typed value).
 *
 * Precedence: DATABASE_URL, then discrete DB_* parts (how docker-compose feeds
 * the api container — no credentialed URL literals in compose), then the
 * synthetic localhost dev default. Dev defaults honor DB_HOST_PORT (the host
 * port compose publishes Postgres on) so a machine whose local 5432 is taken
 * boots with one override. The default connects as the RUNTIME role
 * `bonfire_app` (NOSUPERUSER, NOBYPASSRLS) — never the superuser.
 */
import { z } from "zod";

export type DatabaseTarget =
  | { readonly kind: "url"; readonly url: string }
  | {
      readonly kind: "parts";
      readonly host: string;
      readonly port: number;
      readonly database: string;
      readonly username: string;
      readonly password: string;
    };

/** Environment shape accepted by the resolver (defaults to process.env). */
export type EnvMap = Readonly<Record<string, string | undefined>>;

const DEFAULT_DB_PORT = 5432;
const MAX_TCP_PORT = 65535;

const portSchema = z.coerce.number().int().min(1).max(MAX_TCP_PORT);

function resolveHostPort(env: EnvMap): string {
  const parsed = portSchema.safeParse(env.DB_HOST_PORT);
  return String(parsed.success ? parsed.data : DEFAULT_DB_PORT);
}

/**
 * Synthetic dev-only connection URL for the given role, honoring DB_HOST_PORT.
 * `app` is the runtime bonfire_app role; `migrate` is the migration owner used
 * ONLY by `bun run db:migrate` (never by the application).
 */
export function devDatabaseUrl(role: "app" | "migrate", env: EnvMap = process.env): string {
  const port = resolveHostPort(env);
  switch (role) {
    case "app":
      return `postgres://bonfire_app:bonfire-dev-only-app-pw@127.0.0.1:${port}/bonfire`;
    case "migrate":
      return `postgres://postgres:bonfire-dev-only-superuser-pw@127.0.0.1:${port}/bonfire`;
  }
}

/** Resolve the app-role connection target from the environment. */
export function resolveDatabaseTarget(env: EnvMap = process.env): DatabaseTarget {
  const url = env.DATABASE_URL;
  if (url !== undefined && url.length > 0) {
    return { kind: "url", url };
  }
  const host = env.DB_HOST;
  if (host !== undefined && host.length > 0) {
    const port = portSchema.safeParse(env.DB_PORT);
    return {
      kind: "parts",
      host,
      port: port.success ? port.data : DEFAULT_DB_PORT,
      database: env.DB_NAME ?? "bonfire",
      username: env.DB_USER ?? "bonfire_app",
      // Fail-closed: a missing password means a failed login, never a guess.
      password: env.DB_PASSWORD ?? ""
    };
  }
  return { kind: "url", url: devDatabaseUrl("app", env) };
}
