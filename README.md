# Bonfire DB

Bonfire DB is the open-source clinical data layer underneath AI health apps. It keeps the
canonical record as FHIR R4 in Postgres, exposes app-facing primitives, and builds bounded,
cited context for agents without handing them a raw chart dump.

TicVision is the first real application being built on this repository. The earlier
TicVision-on-Bonfire dogfood repository was a proof of concept; it is reference material,
not the production foundation.

## What is real today

| Capability | Status in this repository |
| --- | --- |
| Canonical FHIR R4 store with version history | Implemented |
| Practice-isolated Postgres access with RLS | Implemented |
| BYO-OIDC authentication and server-owned membership binding | Implemented |
| Hybrid lexical + vector clinical search | Implemented; public `POST /search` route |
| Query-aware cited context packets | Implemented; public `POST /context` route |
| Tamper-evident access audit chain | Implemented |
| Agent proposes, clinician approves and commits | Implemented; public governance routes |
| Fresh SQL-on-FHIR projections | Implemented for the current ViewDefinitions |
| MCP and typed SDK packages | Implemented package surfaces; application integration continues |
| Patient-clinician assignment and consent policy | Not yet implemented |
| SMART-on-FHIR authorization server, attachments, hosted deployment | Roadmap |

The status table is intentionally narrower than the product vision on the landing page. A
capability moves to “implemented” only when it is exercised in this repository.

## Clean-clone development boot

Requirements: Docker and Bun 1.3.14.

```bash
docker compose up -d db --wait
bun install --frozen-lockfile
bun run db:migrate
bun run seed
bun run fhir:load-terminology
bun run projections:rebuild
docker compose up -d --build api --wait
curl http://127.0.0.1:8080/health
curl http://127.0.0.1:8080/ready
```

`/health` is a liveness probe; `/ready` additionally requires the migrated and projected
schema used by the clinical and governance routes.

The compose file ships only synthetic development defaults. Protected routes use a real,
fail-closed OIDC verifier and reject requests until `OIDC_ISSUER`, `OIDC_JWKS_URI`, and
`OIDC_AUDIENCE` point at your identity provider and `(issuer, subject)` memberships exist.

## Public API seam

Clients provide intent. They never provide their actor, role, or Practice; those come from
the verified token and server-side membership.

```bash
curl -X POST http://127.0.0.1:8080/search \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  --data '{"query":"recent motor tic pattern","purposeOfUse":"TREAT"}'

curl -X POST http://127.0.0.1:8080/context \
  -H "authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  --data '{"query":"recent motor tic pattern","purposeOfUse":"TREAT"}'
```

Governed writes use three explicit steps:

- `POST /governance/proposals`
- `POST /governance/proposals/:id/approve`
- `POST /governance/proposals/:id/commit`

Every route passes through the same authenticated, Practice-scoped transaction boundary.

## Repository map

- `apps/api` — Fastify HTTP composition and BYO-OIDC boundary
- `packages/core` — canonical FHIR, RLS tenancy, ABAC, audit, search, and cited context
- `packages/sql-on-fhir` — fresh-on-commit read projections
- `packages/sdk` — typed client surface
- `packages/mcp` — constrained agent tools
- `drizzle` — forward-only database migrations
- `docs/adr` — accepted architectural decisions
- `docs/plans` — product and implementation plans; plans are not proof of shipped behavior

All fixtures and examples must remain synthetic. Never put PHI in source, logs, prompts,
traces, issue bodies, or generated artifacts.
