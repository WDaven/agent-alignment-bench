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
CMD ["node", "apps/world/dist/main.js"]
