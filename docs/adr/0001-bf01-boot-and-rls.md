# ADR 0001 — BF-01: zero-key boot + RLS fail-closed from row zero

Status: accepted · Date: 2026-07-02 · Slice: BF-01

## Decisions

1. **Image pinned by digest.** `pgvector/pgvector:0.8.4-pg18@sha256:212765b6…`
   (pgvector 0.8.4 on Postgres 18). Digest pinning makes the boot reproducible;
   tag-only pins drift.

2. **PG18 volume path.** The named volume mounts `/var/lib/postgresql`, NOT
   `/var/lib/postgresql/data`. PG18 images relocated PGDATA; mounting the old
   path silently discards data on container recreation.

3. **Healthcheck as the app role over TCP.** Bare `pg_isready` reports ready
   during the initdb temp server (unix-socket only, server double-starts), so
   `--wait` could return before init finished. The check runs a real
   `SELECT 1` via psql over TCP as `bonfire_app` — it only goes green once the
   TCP listener, the database, AND the runtime role all exist.

4. **Two-role model.** `postgres` (superuser) owns DDL and is used only by
   `bun run db:migrate` via `MIGRATE_DATABASE_URL` (migrations are a deploy
   step). The app connects exclusively as `bonfire_app`: `LOGIN NOSUPERUSER
   NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT`. Because tables
   are owned by `postgres` and every tenant table is `FORCE ROW LEVEL
   SECURITY`, RLS cannot be silently bypassed — not even by the owner. The
   initdb script binds the role password as a psql variable, never by string
   interpolation.

5. **NULLIF fail-closed policy.** One policy per table, `FOR ALL TO
   bonfire_app`, with BOTH `USING` and `WITH CHECK` =
   `practice_id = NULLIF(current_setting('app.current_practice_id', true), '')::uuid`.
   Unset GUC → NULL; empty-string GUC → NULLIF → NULL; either way the predicate
   is NULL, which returns ZERO rows and never throws — a missing tenant context
   can never fail open or turn into an error a caller might misread as allow.

6. **Transaction-local GUC via one wrapper.** `withTenant()` in @bonfire/core
   is the only exported query path. It validates the practice id (Zod UUID),
   opens ONE transaction, and sets the GUC with
   `set_config('app.current_practice_id', $1, true)` (bound parameter,
   transaction-local). Session-level `SET` is banned: the transaction-local GUC
   dies at COMMIT/ROLLBACK, so pooled connections cannot bleed tenant context
   (proved by the max-1-pool no-bleed test).

7. **Zero-key clean-clone boot.** compose carries inline synthetic defaults
   (`…dev-only…`) for every variable; `.env.example` documents the same values.
   No `.env` is required or committed; no real secret exists anywhere.

## Consequences

- Every future tenant-scoped table copies this recipe (ENABLE + FORCE RLS,
  NULLIF policy, practice_id-leading index) — BF-02 inherits it as substrate.
- /health probes catalog state only (`pg_extension`), never migrated tables,
  because the api is health-checked before migrations run.
