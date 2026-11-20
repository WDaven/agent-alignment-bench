FROM mcr.microsoft.com/playwright:v1.65.1-noble AS base
WORKDIR /repo
RUN npm install -g pnpm@10.33.0
RUN npm install -g @anthropic-ai/claude-code@2.1.224 @openai/codex@0.169.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scenarios ./scenarios
RUN pnpm install --frozen-lockfile --filter "@aab/runner..." \
 && pnpm --filter "@aab/runner..." build \
 && mkdir -p /repo/.bench /runs && chown -R pwuser /repo/.bench /runs
USER pwuser
ENTRYPOINT ["node", "apps/runner/dist/cli.js"]
CMD ["--help"]
