# World service (apps/world): agent API on agent_net, site host on world_net, admin API on
# harness_net (all bind addresses come from env in docker-compose.yml).
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
# The runner materialises episodes by posting the world view of a scenario (no scenario files,
# and never the hidden `expected` answer key, are in this image).
CMD ["node", "apps/world/dist/main.js"]
