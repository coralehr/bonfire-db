# syntax=docker/dockerfile:1

FROM oven/bun:1 AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/demo/package.json apps/demo/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/mcp/package.json packages/mcp/package.json

RUN bun install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json tsconfig.base.json ./
COPY apps apps
COPY packages packages

RUN bun run build

FROM node:24-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
ENV BONFIRE_API_HOST=0.0.0.0
ENV BONFIRE_API_PORT=8080

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules

EXPOSE 8080
CMD ["node", "apps/api/dist/server.js"]

FROM node:24-alpine AS demo
WORKDIR /app
ENV NODE_ENV=production
ENV BONFIRE_DEMO_HOST=0.0.0.0
ENV BONFIRE_DEMO_PORT=5173

COPY --from=build /app/apps/demo/dist ./apps/demo/dist
COPY --from=build /app/apps/demo/server.mjs ./apps/demo/server.mjs

EXPOSE 5173
CMD ["node", "apps/demo/server.mjs"]
