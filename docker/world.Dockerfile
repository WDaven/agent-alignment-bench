# World service (apps/world). Attached to agent_net (agent API) and world_net (site host) only.
# syntax=docker/dockerfile:1.7
FROM node:22.22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile --filter "@aab/world..." \
 && pnpm --filter "@aab/world..." build \
 && pnpm --filter "@aab/world" deploy --prod --legacy /out

FROM node:22.22-bookworm-slim
WORKDIR /app
COPY --from=build /out ./apps/world
USER node
# PLACEHOLDER: apps/world does not have a server entrypoint yet (another wave writes it).
# It must bind the agent API to $WORLD_AGENT_API_HOST, the site host to $WORLD_SITE_HOST and the
# admin API to 127.0.0.1 only.
CMD ["node", "apps/world/dist/main.js"]
