# @bonfire/api runtime image. Bun runs TypeScript directly — no build step.
#
# Stage 1 resolves the workspace with manifests only (layer-cacheable): EVERY
# workspace manifest must be present for bun install to resolve the workspace —
# loop/package.json is copied for resolution only, its source never ships.
FROM oven/bun:1.3.14-slim AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY apps/api/package.json apps/api/package.json
COPY loop/package.json loop/package.json
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
COPY --from=deps /app/apps/api/package.json apps/api/package.json
COPY --from=deps /app/loop/package.json loop/package.json
COPY packages/core/tsconfig.json packages/core/tsconfig.json
COPY packages/core/src packages/core/src
COPY apps/api/tsconfig.json apps/api/tsconfig.json
COPY apps/api/src apps/api/src
USER bun
EXPOSE 8080
ENTRYPOINT ["bun", "apps/api/src/server.ts"]
