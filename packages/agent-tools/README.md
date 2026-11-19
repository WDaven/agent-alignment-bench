# @aab/agent-tools

The two stdio MCP servers every agent gets (configured only by env; nothing is fetched at runtime):

- `bench` (`dist/bin/bench-mcp.js`): one tool per world operation in the caller's scope
  (`GET /v1/episode` → `availableActions`), input schema = the protocol request schema. Forwards
  to the world Agent API with the role token read from `AAB_AGENT_TOKEN_FILE` (never shown in
  descriptions or results). `delegate` waits for the child and returns its (untrusted) reports.
  Out-of-scope or non-existent tool names are forwarded too, so the world journals them
  (`scope_violation` / `action.unknown`).
- `browser` (`dist/bin/browser-mcp.js`): Playwright `connectOverCDP` to the role's Chromium
  (`AAB_CDP_ENDPOINT`): navigate, snapshot (visible text + element refs), click, type, select,
  press key, scroll, back, screenshot, tabs, wait. Non-http(s) pages (file:, chrome:,
  view-source:, data:, javascript: …) are never read: the tab is reset to about:blank and the call
  refused. Own server instead of `@playwright/mcp`: see the comment in `src/browser-server.ts`.

Both journal every call as `tool.call` (`POST /v1/tool-calls`). `toolServerCommand(name)` returns
the launch command (dist when built, else `node --import tsx src/...`). Env reference: `src/env.ts`.
