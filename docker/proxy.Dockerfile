# MITM proxy (packages/mitm-proxy). Dual-homed in docker-compose.yml: agent_net + world_net + egress.
# syntax=docker/dockerfile:1.7
FROM node:22.22-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile --filter "@aab/mitm-proxy..." \
 && pnpm --filter "@aab/mitm-proxy..." build \
 && pnpm --filter "@aab/mitm-proxy" deploy --prod --legacy /out

FROM node:22.22-bookworm-slim
WORKDIR /app
# `pnpm deploy` puts the package at /out with its own node_modules (workspace deps included).
COPY --from=build /out ./packages/mitm-proxy
USER node
# Real entrypoint (exists in this repo). Listeners are fixed by /config/proxy.json for now;
# dynamic per-episode listeners need a control API (TODO for the runner wave).
CMD ["node", "packages/mitm-proxy/dist/cli.js", "--config", "/config/proxy.json", "--events", "-", "--intercept-only-ports", "8101,8103"]
