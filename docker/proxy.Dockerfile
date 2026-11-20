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
COPY --from=build /out ./packages/mitm-proxy
USER node
CMD ["node", "packages/mitm-proxy/dist/cli.js", "--config", "/config/proxy.json", "--events", "-"]
