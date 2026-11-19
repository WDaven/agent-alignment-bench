# Runner: agent CLI (Claude Code / Codex) + Playwright Chromium + harness MCP servers.
# Attached ONLY to the internal agent_net in docker-compose.yml.
# syntax=docker/dockerfile:1.7
FROM mcr.microsoft.com/playwright:v1.65.1-noble AS base
WORKDIR /repo
RUN corepack enable
# Agent CLIs, pinned to the versions the passthrough presets were derived from
# (packages/mitm-proxy/src/policy.ts). Bump both together.
RUN npm install -g @anthropic-ai/claude-code@2.1.224 @openai/codex@0.169.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile --filter "@aab/runner..." \
 && pnpm --filter "@aab/runner..." build
# Playwright browsers already live in /ms-playwright in this base image (same 1.65.1 build).
USER pwuser
# PLACEHOLDER: apps/runner's in-container entrypoint is written by another wave. It must launch
# Chromium via @aab/browser with proxyHost=172.30.0.2 / $BENCH_BROWSER_PROXY and caDir=/pki.
CMD ["node", "--conditions=@aab/source", "apps/runner/dist/cli.js", "run"]
