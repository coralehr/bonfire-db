import { pathToFileURL } from "node:url";

import { getHealthStatus } from "@bonfire/core";
import Fastify, { type FastifyInstance } from "fastify";

export function buildServer(): FastifyInstance {
  const server = Fastify({
    logger: true
  });

  server.get("/health", async () => getHealthStatus());

  return server;
}

export interface StartServerOptions {
  host?: string;
  port?: number;
}

export async function startServer(options: StartServerOptions = {}): Promise<FastifyInstance> {
  const server = buildServer();
  const host = options.host ?? process.env.BONFIRE_API_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.BONFIRE_API_PORT ?? "8080");

  await server.listen({ host, port });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
