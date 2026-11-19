# Architecture — core tooling

The full product spec is [handoff-spec.md](handoff-spec.md). This document records
the decisions for the **core tooling** in this repo. Where the two disagree, this
document wins.

## Scope

In scope: protocol types, eval CA + MITM proxy, controlled Chromium launcher, world
state (event journal, ledger, policy), world API, scenario loader, graders B0–B7,
agent adapters (scripted, Claude Code CLI, Codex CLI), agent tool servers (MCP),
delegation, runner CLI, artifacts, minimal report.

**Out of scope for now: the simulated websites** (search engine, merchants, wallet,
inbox UIs and their trap templates). The world service exposes a `SitePlugin`
contract they will be written against. One built-in diagnostic host,
`probe.eval.test`, exists only so the interception path can be tested end to end.

## Agents under test

The evaluated agents are local CLIs: **Claude Code** (`claude -p`) for Anthropic
models and **Codex** (`codex exec`) for OpenAI models. The harness spawns the CLI as
a child process with:

- an isolated config home (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) and empty working dir,
- built-in web/shell/file tools disabled; the only tools are two MCP servers the
  harness provides:
  - `browser` — drives the harness-owned Chromium (Playwright over CDP),
  - `bench` — the typed world operations allowed for that role (spec §6),
- proxy + CA environment (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY=`,
  `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CODEX_CA_CERTIFICATE`) so that anything
  the CLI process itself tries to fetch also lands on the proxy.

CLI flags must be taken from the installed `claude --help` / `codex --help`, not
from memory. Other agents plug in through the same `AgentAdapter` interface.

## Interception (the man in the middle)

```text
agent CLI ──(model API only: tunnelled, not decrypted)──────────► api.anthropic.com / api.openai.com
    │ MCP
    ▼
Chromium ──► MITM proxy ──► *.eval.test  → TLS terminated with eval-CA leaf → world service
agent CLI ─►     │      ──► allowlisted passthrough hosts → blind CONNECT tunnel
                 └──────► everything else → refused, logged as network.denied
```

**Eval CA** (`packages/pki`)
- Generated per machine into `.bench/pki/` (gitignored). Never installed into the OS
  or user trust store; never committed. Trust is injected per process only.
- Root cert carries a critical X.509 **name constraint permitting only `eval.test`**,
  so a leaked key cannot impersonate real sites. Passthrough hosts are therefore
  never decrypted.
- Leaf certs are minted on demand per SNI host, cached, short-lived.
- Chromium trusts it via an isolated profile (no system store changes).

**MITM proxy** (`packages/mitm-proxy`)
- HTTP forward proxy handling plain requests and `CONNECT`.
- Per-host policy: `intercept` (`*.eval.test`), `passthrough` (configurable model
  API allowlist), `deny` (default).
- **One listener port per role per episode.** The proxy strips client-supplied
  `x-bench-*` headers and adds trusted `x-bench-episode` / `x-bench-role` before
  forwarding to the world service. That is how browser-originated requests get an
  identity.
- Every request, tunnel and denial is appended to the event journal
  (`network.request`, `network.tunnel`, `network.denied`).
- It never routes to the world admin API.

**Chromium** (`packages/browser`)
- Fresh profile per role per episode, all traffic forced through that role's proxy
  port (including loopback), QUIC/WebRTC/background networking off, service workers
  blocked, no extensions. Exposes a CDP endpoint for the `browser` MCP server.
  Captures Playwright trace, HAR, screenshots.

**Hard isolation.** Proxy settings are not a security boundary. `docker-compose.yml`
runs the agent + browser on an `internal` network whose only route out is the proxy
container. Local (non-container) runs are for development and are labelled
`isolation: "proxy-only"` in run metadata.

## World service

`packages/world-state` — SQLite per run. Append-only `events` table with
world-assigned strict `seq` and a deterministic virtual clock; projections for
accounts, funds, credits, coupons, refunds, orders, subscriptions, approvals,
delegations, claims, authorizations, attempts. All money is integer cents. Policy is
evaluated at action time; **every attempt is journaled before the decision**, and
denied attempts stay in the journal.

`apps/world` — Fastify.
- **Agent API**: the spec §6 operations, authenticated by per-episode per-role bearer
  tokens, scope-checked against `authorization.scopeByRole`.
- **Site host**: requests arriving from the proxy for `*.eval.test`, dispatched by
  `Host` to registered `SitePlugin`s. Sites call the same typed operations; page
  text can never mutate the ledger directly.
- **Admin API**: separate listener (not reachable through the proxy): materialize,
  reset, dump state, export events.

Hidden `expected` values from a scenario are loaded only by the grader process and
are never present in the world service's agent-reachable surface.

## Grading

`packages/graders` — one pure function per benchmark over
`(episodeSpec, initialState, orderedEvents, finalState)`, plus the global outputs.
Attempted vs executed are separate. Traps never encountered are `not_exposed`.

## Run layout

```text
runs/<runId>/ episode.json events.jsonl grades.json world-final.json
              trace.zip screenshots/ network.har report.html meta.json
```
