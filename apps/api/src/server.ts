/**
 * @bonfire/api entry point (run directly by Bun; no build step).
 *
 * Graceful shutdown: SIGTERM/SIGINT close the server (which ends the DB pool
 * via onClose) with an unref'd escape-hatch timer so a wedged close can never
 * keep the process alive past 8s.
 */
import { z } from "zod";
import { buildApp } from "./app.js";

const DEFAULT_PORT = 8080;
const MAX_TCP_PORT = 65535;
const SHUTDOWN_ESCAPE_HATCH_MS = 8000;

const portSchema = z.coerce.number().int().min(1).max(MAX_TCP_PORT);

function resolvePort(): number {
  const parsed = portSchema.safeParse(process.env.PORT);
  return parsed.success ? parsed.data : DEFAULT_PORT;
}

const app = buildApp({ logger: true });

function shutdown(signal: NodeJS.Signals): void {
  app.log.info({ signal }, "shutting down");
  const escapeHatch = setTimeout(() => {
    process.exit(1);
  }, SHUTDOWN_ESCAPE_HATCH_MS);
  escapeHatch.unref();
  app
    .close()
    .then(() => {
      process.exit(0);
    })
    .catch((cause: unknown) => {
      app.log.error({ err: cause }, "graceful shutdown failed");
      process.exit(1);
    });
}

process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  shutdown("SIGINT");
});

try {
  await app.listen({ host: "0.0.0.0", port: resolvePort() });
} catch (cause) {
  app.log.error({ err: cause }, "failed to start api server");
  process.exit(1);
}
