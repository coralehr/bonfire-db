# Bonfire DB

Bonfire DB is a local-first clinical backend demo scaffold for AI-health
builders. This repository currently contains the BF-01 foundation slice only:
workspace packages, a Fastify health endpoint, a Vite React shell, and Docker
compose for Postgres 18 with pgvector.

## Current Status

What runs today:

- Bun workspace with `apps/api`, `apps/demo`, `packages/core`,
  `packages/sdk`, and `packages/mcp`.
- Fastify API health endpoint at `GET /health`.
- Vite React demo shell.
- Docker compose services for Postgres 18 + pgvector, API, and demo UI.
- Localhost-only host port bindings.

Roadmap items not implemented yet include schema, seed data, ABAC, audit,
semantic search, FHIR, MCP tools, SDK methods, and the five browser demo beats.
This scaffold is not a production clinical system and is not a HIPAA compliance
claim.

## Requirements

- Bun 1.3 or newer
- Node.js 24 LTS compatibility for runtime code
- Docker with Compose

## Quickstart

```bash
bun install --frozen-lockfile
bun run typecheck
docker compose up -d
curl -fsS http://127.0.0.1:8080/health
```

The API binds to `127.0.0.1:8080` on the host. The demo UI binds to
`127.0.0.1:5173` on the host. Postgres binds to `127.0.0.1:15432` on the host
and remains `5432` inside the compose network.
