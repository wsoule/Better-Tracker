# One image for both Railway services. The web service runs the default
# command (next start); the worker cron service overrides the start command
# with `node apps/worker/dist/index.js tick`. Kept out of the repo root on
# purpose: Railway auto-detects a root Dockerfile for every service.
#
# Point each service at it with RAILWAY_DOCKERFILE_PATH=deploy/Dockerfile.

# Node matches the .prototools / .node-version pin.
FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
ENV CI=1 NEXT_TELEMETRY_DISABLED=1

# pnpm 12 ships as a native binary that corepack cannot launch yet, so the
# image installs the pinned version (package.json "packageManager",
# .prototools) with npm. This is the container's toolchain, not a dev setup.
RUN npm install --global pnpm@12.6.0 && pnpm --version

# Dependencies first, from the lockfile alone (`pnpm fetch` fills the store
# with every locked package), so a source change reuses this layer and the
# install below runs offline.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile
# Builds packages in dependency order, then both apps (mirrors moon's graph).
RUN bash scripts/build-all.sh
# The runtime gets production dependencies only: a fresh install from the
# store without devDependencies (TypeScript, tsdown, moon, oxlint, test
# libraries; an install over the full tree would leave them in
# node_modules/.pnpm), and no Next build cache.
RUN rm -rf node_modules packages/*/node_modules apps/*/node_modules \
      apps/planner/.next/cache \
    && pnpm install --offline --frozen-lockfile --prod

FROM node:24.21.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
# Started from the app's own directory: run from /app, `next start
# apps/planner` cannot load next.config.ts's import of ./lib/*.ts ("Cannot
# find module './lib/security-headers'"). The worker's start command still
# runs from /app.
CMD ["sh", "-c", "cd apps/planner && exec ./node_modules/.bin/next start --hostname 0.0.0.0 --port \"${PORT:-3000}\""]
