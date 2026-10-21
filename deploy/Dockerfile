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

COPY . .
RUN pnpm install --frozen-lockfile
# Builds packages in dependency order, then both apps (mirrors moon's graph).
RUN bash scripts/build-all.sh

FROM node:24.21.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
CMD ["sh", "-c", "exec apps/planner/node_modules/.bin/next start apps/planner --hostname 0.0.0.0 --port \"${PORT:-3000}\""]
