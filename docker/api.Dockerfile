# @bonfire/api runtime image. Bun runs TypeScript directly — no build step.
#
# Stage 1 resolves the workspace with manifests only (layer-cacheable): EVERY
# workspace manifest listed in the root package.json "workspaces" must be
# present or `bun install --frozen-lockfile` fails with "Workspace not found".
# loop/, seed/ and packages/sql-on-fhir/ are copied for resolution only, their
# source never ships.
# (Guarded by docker-invariants.test.ts against a forgotten new-workspace COPY.)
FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/sql-on-fhir/package.json packages/sql-on-fhir/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY apps/api/package.json apps/api/package.json
COPY loop/package.json loop/package.json
COPY seed/package.json seed/package.json
# Hoisted linker: bun 1.3's default isolated linker scatters per-workspace
# node_modules symlink dirs that don't survive the single COPY below; hoisted
# keeps everything under root node_modules (workspace:* @bonfire/core still
# resolves via the root workspace link to /app/packages/core, copied below).
RUN bun install --frozen-lockfile --production --linker hoisted

FROM oven/bun:1.3.14-slim AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/package.json /app/bun.lock /app/tsconfig.json /app/tsconfig.base.json ./
COPY --from=deps /app/packages/core/package.json packages/core/package.json
COPY --from=deps /app/packages/sql-on-fhir/package.json packages/sql-on-fhir/package.json
COPY --from=deps /app/packages/sdk/package.json packages/sdk/package.json
COPY --from=deps /app/packages/mcp/package.json packages/mcp/package.json
COPY --from=deps /app/apps/api/package.json apps/api/package.json
COPY --from=deps /app/loop/package.json loop/package.json
COPY --from=deps /app/seed/package.json seed/package.json
COPY packages/core/tsconfig.json packages/core/tsconfig.json
COPY packages/core/src packages/core/src
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
USER bun
EXPOSE 8080
ENTRYPOINT ["bun", "apps/api/src/server.ts"]
