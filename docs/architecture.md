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
- **Two listener ports per role per episode**: `browser` (intercept-only — the proxy removes
  every passthrough rule from it) and `cli` (model-API passthrough). The proxy strips
  client-supplied `x-bench-*` headers and adds trusted `x-bench-episode` / `x-bench-role` /
  `x-bench-delegation` and the proxy→world shared secret before forwarding to the world
  service. That is how browser-originated requests get an identity.
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

World invariants (`packages/world-state`, `apps/world`):

- **Storage** (`SqliteJournal`): the `events` table is append-only (UPDATE/DELETE abort via
  triggers) and a trigger requires `seq = max(seq) + 1` from 0; `meta` is write-once; the
  `projection` row is only a cache written in the same transaction as each event, and
  `rebuild()` recomputes it from `events` alone.
- **Virtual clock**: every catalog attempt advances `VIRTUAL_MS_PER_ATTEMPT` (1 s, one agent
  step); every other event advances `VIRTUAL_MS_PER_EVENT` (1 ms). Order quotes expire after
  `QUOTE_TTL_MS` (30 virtual minutes).
- **One place for state change**: `planAction` (planner) is a pure decision for one attempt;
  `WorldStore` journals what it returns; `applyEvent` (projection) is the only reducer, so
  `replay(spec, id, events).world` always equals the live projection. Credits are allocated in the
  order given, each up to its remaining balance (`allocateCredits`, shared by planner and reducer).
- **Ledger rules**: a resource backs at most one extension (no double counting through a second
  claim); forbidden actions can never be approved, whatever the oracle rules say; approvals are
  single-use for the same role, action, order and a sufficient amount; checkout consumes its own
  approval, any other approval-gated action consumes the applicable one.
- **Ingest**: events produced outside the world (`INGESTIBLE_EVENT_TYPES`: proxy, browser, site
  host, agent tools, runner) are validated before they touch the journal, so a bad draft never
  consumes a `seq`; a repeated `trap.exposed` for the same (trap, url) is dropped.
- **Agent API**: the body is accepted as raw text and journaled as the attempt's request before
  any validation (malformed JSON is still a recorded attempt, denied `invalid_request`); denials
  are HTTP 200 with `ok: false`; unknown operation names become `action.unknown`;
  `GET /v1/delegations/:id` answers only the delegating role; `POST /v1/tool-calls` takes role,
  delegation and episode from the bearer token, never the body, and graders never use `tool.call`
  for policy decisions.
- **Site host**: a request without the trusted identity (or, when configured, the proxy secret)
  gets 403 and is not journaled; an unknown host gets a 404 page; each plugin's routes are scoped to
  its own hosts; every identified request is journaled as `page.navigated`.
- **Secrets**: `runSecret`, `adminSecret` and `proxySecret` are each at least 16 characters and
  pairwise distinct (`createWorld` throws otherwise).
- **Process** (`apps/world/src/main.ts`, the docker image): `AAB_RUN_SECRET[_FILE]`,
  `AAB_ADMIN_SECRET[_FILE]`, optional `AAB_PROXY_SECRET[_FILE]`; bind addresses `AAB_WORLD_HOST`
  (agent API, default 127.0.0.1), `AAB_SITE_HOST` (default `AAB_WORLD_HOST`), `AAB_ADMIN_HOST`
  (default 127.0.0.1); ports `AAB_AGENT_API_PORT` / `AAB_SITE_PORT` / `AAB_ADMIN_PORT` (0 = free);
  `AAB_SCENARIOS_DIR` enables materialize-by-id; `AAB_WORLD_DATA_DIR` (default in-memory). It prints
  one JSON line with the bound ports.

## Grading

`packages/graders` — one pure function per benchmark over
`(episodeSpec, initialState, orderedEvents, finalState)`, plus the global outputs.
Attempted vs executed are separate. Traps never encountered are `not_exposed`.

## Runner

`bench run` self-hosts a fresh world + proxy per episode in local mode (no daemon); compose mode
drives containerised world/proxy through the admin API and the proxy control endpoint. Grading
runs in the runner after the agent stopped. Delegated children are run by `@aab/subagents` with
their own token, listeners, browser and trace.

`runEpisode` (`apps/runner/src/episode.ts`) follows spec §10:

1. load the scenario (caller); 2. materialize the world view only — `expected` stays in the
   runner's scope; 3. start the role's proxy listeners; 4. start its browser; 5. start the agent;
   6. capture; 7. stop on final response, max steps, timeout or error — browsers and listeners
   are closed _before_ `episode.ended` so late network events are journaled in-episode; 8. grade,
   in the runner, which is the first time `expected` meets the journal; 9. write artifacts;
   10. reset: stop agents, close browsers (profiles deleted), remove listeners, drop the database.

- **Provisioning a role** (parent or delegated child): its own `browser` and `cli` listeners, its
  own Chromium profile, token file and MCP server specs.
- **Backends**: `LocalBackend` subscribes to journal events synchronously; `RemoteBackend` polls,
  and relays proxy network events into the world journal through the admin API because the
  containerised proxy has no world access. A malformed network event from the proxy is dropped as
  a proxy bug, not agent behaviour. The agent API and admin API are never proxy targets. Only a
  local backend needs the CA private key; in compose mode the runner holds public trust material
  only (`ca.pem`, `ca-bundle.pem`, `leaf-pub.pem`).
- **Identifiers**: run ids are `run-YYYYMMDDTHHMMSS-<6 hex>` (`newRunId`). Episode ids and
  materialized run ids are deterministic but opaque: keyed by a per-machine secret
  (`.bench/secrets`, mode 0600, `stableIdSecret`), so the same scenario + seed + repetition gives
  a byte-identical journal (§12.10) while an agent cannot recover the scenario id, variant or seed
  by hashing candidates. Role tokens (`deriveRoleToken`) come from a fresh random run secret per
  run, never from the seed (which is not secret); a delegated child gets its own token bound to
  its `delegationId`.
- **Delegation**: the child's step and wall-clock limits default to its view's `maxSteps` /
  `maxWallMs`; exceeding them ends the delegation `timeout`; stopping the manager ends open
  delegations `cancelled`. A report the runner files on the child's behalf (`via: runner`) is
  never judged as an agent attempt.

## Agent tools (`packages/agent-tools`)

- The `bench` and `browser` MCP servers are configured only by environment (`TOOL_ENV`:
  `AAB_AGENT_API_URL`, `AAB_AGENT_TOKEN_FILE`, `AAB_CDP_ENDPOINT`, `AAB_SCREENSHOT_DIR`,
  `AAB_DELEGATION_WAIT_MS` default 600000, `AAB_MCP_ENV_REPORT`), never by tool arguments, so
  nothing the model sends can redirect them. The role token is read from a 0600 file, so it never
  appears in argv, the CLI's MCP config, tool descriptions or tool results.
- `AAB_MCP_ENV_REPORT` makes each server append the NAMES (never values) of the variables it
  received, which is how the harness verifies what env a CLI hands its MCP children.
- Tool-call ids are deterministic, `tc-<server>-<role>[-<delegation>]-<n>`. Journaling a
  `tool.call` is best effort; the world journals the action itself regardless.
- `world-client.ts` repeats the Agent API paths instead of depending on `apps/world`.
- Why an own `browser` server instead of `@playwright/mcp --cdp-endpoint`: it pins its own
  Playwright build (two copies in the runner image, and no fetching at run time without internet);
  it has no hook to journal each call; its tool surface includes code evaluation, file upload and
  network inspection that would need filtering; and the non-http(s) refusal must cover every
  content-returning tool, not only navigation. Content returned to the model only ever comes from
  http(s) pages or `about:blank`: a tab on any other scheme is reset to `about:blank` and the call
  refused. `SNAPSHOT_SCRIPT` is kept as source text, not a TS function, so no transpiler helper
  (esbuild's `__name`) leaks into the page.
- `toolServerCommand(name)` launches `node dist/bin/<name>-mcp.js` when built, else
  `node --import tsx src/bin/<name>-mcp.ts`; nothing is fetched at run time.

## Artifacts, determinism and reports

- `stableStringify` sorts object keys (code-unit order) at every depth and writes LF with a
  trailing newline, so identical runs are byte-identical.
- The leakage guard (`assertNoHiddenLeak`) scans every write to the run directory and to other
  agent-reachable paths while the run is live for `HIDDEN_KEYS` (camelCase and snake_case) and
  explicit hidden markers; grades and report cannot be written while live (`LiveRunWriteError`);
  agent-supplied payloads (raw requests in `events.jsonl`, HAR bodies, binaries) are checked for
  explicit markers only.
- The materializer is pure: no clock, no `Math.random`. Randomness comes from `fnv1a32` +
  `mulberry32` (`packages/scenarios/src/prng.ts`), with `deriveSeed` per labelled purpose (for
  example `siteSeedFor` per site plugin).
- Reports treat page text and agent output as untrusted: everything rendered goes through
  `escapeHtml`. `apps/report` depends only on `@aab/protocol`; the suite summary takes the
  `aggregate` result as data through a structural subset of `SuiteAggregate`.

## Run layout

```text
runs/<runId>/ episode.json events.jsonl grades.json world-initial.json world-final.json
              trace.zip screenshots/ network.har report.html meta.json transcripts/ children/
```
