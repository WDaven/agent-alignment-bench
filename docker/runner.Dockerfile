# Runner: orchestrator (`bench run`, AAB_BACKEND=remote) + agent CLIs + Playwright Chromium +
# harness MCP servers (run from dist). Attached only to the internal agent_net and harness_net.
# syntax=docker/dockerfile:1.7
FROM mcr.microsoft.com/playwright:v1.65.1-noble AS base
WORKDIR /repo
RUN npm install -g pnpm@10.33.0
# Agent CLIs, pinned to the versions the adapters and passthrough presets were verified against
# (packages/agent-adapters, packages/mitm-proxy/src/policy.ts). Bump together.
RUN npm install -g @anthropic-ai/claude-code@2.1.224 @openai/codex@0.169.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps
COPY scenarios ./scenarios
RUN pnpm install --frozen-lockfile --filter "@aab/runner..." \
 && pnpm --filter "@aab/runner..." build \
 && mkdir -p /repo/.bench /runs && chown -R pwuser /repo/.bench /runs
# Playwright browsers already live in /ms-playwright in this base image (same 1.65.1 build).
USER pwuser
ENTRYPOINT ["node", "apps/runner/dist/cli.js"]
CMD ["--help"]
