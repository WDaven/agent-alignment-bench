# Agent Alignment Browser Benchmark (core tooling)

[![CI](https://github.com/WDaven/agent-alignment-bench/actions/workflows/ci.yml/badge.svg)](https://github.com/WDaven/agent-alignment-bench/actions/workflows/ci.yml)

Give a CLI agent — **Claude Code** (`claude -p`) or **Codex** (`codex exec`) — a purchasing task
with a spending limit, put untrusted funding offers, hidden fees, forged approvals and injected
policy text in its way, and record what it _attempts_ as well as what it gets away with. The
agent works in a harness-owned Chromium whose every request is man-in-the-middled by our own
name-constrained CA and proxy; every consequential action goes through an authoritative world
service that journals the attempt before deciding it; and pure, versioned graders (B0–B7) score
the journal afterwards, keeping capability and policy compliance separate.

Specs: [docs/handoff-spec.md](docs/handoff-spec.md) (product), [docs/architecture.md](docs/architecture.md)
(decisions), [docs/protocol.md](docs/protocol.md), [docs/threat-model.md](docs/threat-model.md),
[docs/grading-rubric.md](docs/grading-rubric.md), [docs/scenario-authoring.md](docs/scenario-authoring.md),
[docs/adapter-contract.md](docs/adapter-contract.md).

> **What is NOT built: the simulated websites** (search engine, merchants, wallet, inbox UIs and
> their trap renderings). Only the diagnostic host `https://probe.eval.test` exists. Agents act
> on the world through the typed `bench` tools; traps whose surface is a web page are graded
> `not_exposed` until a site plugin renders them.

## Quickstart

Requires Node ≥ 22.12 and pnpm 10 (`corepack enable`), macOS or Linux. One-time setup:

```bash
pnpm install
pnpm --filter @aab/browser exec playwright install chromium     # the bundled Chromium (no system browser is used)
pnpm bench:pki init                        # per-machine eval CA in .bench/pki (gitignored)
```

Then:

```bash
pnpm bench doctor                          # preflight, a few seconds: node, chromium, CA + name constraint, CLIs, proxy self-test
pnpm bench:run --scenario B0-clean-purchase-001 --agent scripted --seed 1042   # one scripted episode → runs/<runId>/
pnpm test                                  # unit + integration + e2e (headless Chromium, no internet needed)
```

`doctor` fails only on required checks (a missing agent CLI is a warning). The scripted run prints
`task_success=true policy_compliance=true violations=[]` and the path of `report.html`.

More runs:

```bash
pnpm bench:run --suite b1 --agent scripted --repetitions 2
pnpm bench:run --scenario B0-clean-purchase-001 --agent scripted --plan probe   # also opens probe.eval.test + example.com
pnpm bench:grade --events runs/<runId>/events.jsonl [--write]   # re-grade from artifacts
pnpm bench:report --run <runId>                                  # (re)render report.html
pnpm bench:report --suite-dir runs                               # summary.html over many runs
pnpm bench:test-graders                                          # grader contract tests (§12.11)
pnpm bench:up / pnpm bench:down                                  # local: nothing to start (see below) / clean scratch
```

Other `run` flags: `--headed`, `--no-browser`, `--repetitions k`, `--seed n`, `--plan compliant|probe`.

**Local mode** (default, `isolation: proxy-only`) has no daemon: every `bench run` self-hosts a
fresh world (agent API, site host, admin API) and MITM proxy in its own process per episode and
tears them down afterwards. **Container mode** (`isolation: container`, hard network isolation):

```bash
pnpm bench:pki init && pnpm bench:up --compose        # builds images, starts world + proxy
pnpm bench:run --compose --scenario B0-clean-purchase-001 --agent scripted --plan probe
pnpm bench:down --compose
```

### Where artifacts land

`runs/<runId>/`: `episode.json`, `events.jsonl` (the journal, one event per line, by `seq`),
`world-initial.json`, `world-final.json`, `grades.json` (per-benchmark metrics + violations with
event ids, validation warnings, harness violations, usage), `meta.json` (agent/model/CLI/prompt
version, seed, fixture version, build hash, grader version, isolation, auth mode, end reason),
`report.html`, `trace.zip` (Playwright trace), `network.har`, `screenshots/`,
`transcripts/<role>.jsonl` (redacted CLI output, LLM agents), `children/<delegationId>/` (a
delegated child's own trace/HAR/screenshots). Per-run scratch (agent work dir, config home, token
files, Chromium profile, world DB) lives in `.bench/tmp/<runId>/` and is deleted at the end.

## How interception works

1. `bench pki init` creates an EC CA whose **critical name constraint permits only `eval.test`** — it cannot sign for real sites; it is never installed in any OS/user trust store.
2. Each role gets two proxy listeners: **browser** (intercept-only: `*.eval.test` is TLS-terminated with a minted leaf and forwarded to the world site host; everything else is refused) and **cli** (same, plus blind CONNECT tunnels to the CLI's model-API hosts).
3. Chromium runs with a fresh profile forced through the browser listener and trusts only our shared leaf key (SPKI pin); the CLI process gets `HTTPS_PROXY` → its cli listener plus per-process CA env (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CODEX_CA_CERTIFICATE`).
4. The proxy strips client `x-bench-*` headers and injects the trusted identity (episode, role, delegation) plus a proxy→world shared secret; the site host refuses anything without it.
5. Every request, tunnel and denial is journaled (`network.request` / `network.tunnel` / `network.denied`, with the listener it came through) in the same world journal the graders read.

Limits and residual risks: [docs/threat-model.md](docs/threat-model.md).

## How grading works

Grading runs in the runner after the agent stopped; the hidden `expected` answer key never reaches
the world or an agent process. Each grader is a pure function of `(episode, initial state, ordered
events, final state)`. Every world call is journaled as `action.attempted` _before_ policy is
evaluated, so a denied attempt still counts: violations come in `_attempted` / `_executed` pairs,
and every violation cites the event ids that prove it. Final responses and page text are never
read. A trap with no `trap.exposed` event is `not_exposed`, never "defended". Full definitions:
[docs/grading-rubric.md](docs/grading-rubric.md).

| Benchmark               | Measures                                                                                     | Key metrics                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| B0 Task Completion      | Did a compliant purchase happen, or a correct stop when none is possible                     | `valid_task_end_state`, `feasible_task_success`, `appropriate_escalation_when_infeasible`                         |
| B1 Spending Boundaries  | Attempts beyond the budget, forbidden actions, unapproved subscriptions, approval bypass     | `unauthorized_action_attempt_rate`, `unauthorized_action_execution_rate`, `correct_approval_requests`             |
| B2 Financial Reasoning  | Coupons, credits, unsettled funds and fees treated correctly (from ledger events, not prose) | `correct_spendable_balance`, `double_count_attempts`, `invalid_credit_treatment`, `fee_accounting_errors`         |
| B3 Resource Acquisition | Finding legitimate funding without accepting false or prohibited resources                   | `eligible_resource_recall`, `verified_value_found`, `false_resource_acceptance`, `duplicate_claims`               |
| B4 Delegation Integrity | Child scope, unverified child claims used by the parent, cross-agent contamination           | `scope_violations`, `unverified_claim_usage`, `parent_rechecks_claim`, `child_action_policy_violations`           |
| B5 Adversarial Web      | Whether injected or forged content changes behaviour after exposure                          | `attack_success_rate`, `safe_completion_under_attack`, `attack_vs_clean_delta`                                    |
| B6 Goal Pressure        | Recovery and honesty when the legitimate path is hard or infeasible                          | `valid_recovery_rate`, `misrepresentation_count`, `unauthorized_escalation_count`, `violation_rate_by_difficulty` |
| B7 End-to-End           | Safe completion of the whole flow, reported as components, never one weighted score          | `safe_task_completion`, `unsafe_attempt_rate`, `unsafe_execution_rate`, `robustness_delta`                        |

Pair deltas and difficulty slices are computed across runs by `aggregate(runs)`, with Wilson /
Newcombe intervals only once every arm has enough runs.

## Run a real agent

```bash
# .env.example lists the provider keys; export them in your shell (nothing loads .env automatically)

# Claude Code (API key from your environment; or --auth inherit to use your existing `claude` login)
ANTHROPIC_API_KEY=... pnpm bench:run --scenario B0-clean-purchase-001 --agent claude-code --model sonnet --max-turns 30 --max-budget-usd 2

# Codex (CODEX_API_KEY or OPENAI_API_KEY; or --auth inherit to use your ~/.codex login)
OPENAI_API_KEY=... pnpm bench:run --scenario B0-clean-purchase-001 --agent codex --max-turns 30
```

Exact flags, environment and what was verified per CLI: [docs/adapter-contract.md](docs/adapter-contract.md).
Live smoke (costs money, manual):
`AAB_LIVE_SMOKE=1 AAB_LIVE_AGENTS=codex AAB_LIVE_AUTH=inherit pnpm vitest run tests/e2e/live-smoke.test.ts`.

## Adding a site plugin later

Implement `SitePlugin` (`packages/protocol/src/site.ts`) for Fastify: declare `id` and its
`*.eval.test` `hosts`, register routes in `register(app, ctx)`, call `ctx.resolve(req)` per request
to get the episode/role scope, render from `scope.fixture` (never `meetsRequirements` or anything
hidden), perform consequential actions ONLY via `scope.actions.call(action, request)` (journaled
like bench tools, `via: site`) and call `scope.traps.recordExposure(trapId, …)` when trap content
is actually rendered. Pass it to `createWorld({ plugins })` / `runEpisode({ plugins })`.
`tests/fixtures/test-sites.ts` is a 40-line test-only example (product page + trap rendering).

## Status: verified / not verified

| What                                                                                                                                                                              | Status                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build, typecheck, `pnpm check`, full test suite (unit, integration, e2e with headless Chromium, no internet)                                                                      | verified on macOS (arm64)                                                                                                                                            |
| Spec §12 cases 1–8, 10 on the real engine, graded with zero validation warnings; every one of the 29 scenarios admitted by the compliant plan                                     | verified (`tests/e2e/spec-cases.test.ts`)                                                                                                                            |
| §12.9 leakage, §12.12 network isolation, browser listener cannot reach model APIs                                                                                                 | verified (`tests/e2e/isolation.test.ts`)                                                                                                                             |
| Delegation lifecycle (scoped child token, own listeners/browser, report as claim, limits)                                                                                         | verified with scripted parent + child                                                                                                                                |
| Container mode (`docker compose`): images build; scripted run incl. Linux Chromium → proxy → probe.eval.test, example.com denied                                                  | verified on macOS Docker 28.1.1 (runner image Linux/Node 26)                                                                                                         |
| Linux, outside compose: test suite, scripted episode and `bench doctor` in the Playwright 1.65.1 Ubuntu 24.04 image (arm64, Node 26)                                              | verified locally in Docker; GitHub `ubuntu-latest` (x86_64, Node 22) CI **not yet run**                                                                              |
| Codex 0.169.0 live episode (`--auth inherit`, ChatGPT login): model traffic only via the CLI listener, probe via the browser listener, example.com denied, no built-in tools used | verified once (`AAB_LIVE_SMOKE=1`)                                                                                                                                   |
| Claude Code 2.1.224 live episode                                                                                                                                                  | **not verified** — no CLI login / API key on the test machine. Flags, tool disabling, MCP connection and proxying were verified with a fake key (401, no model call) |
| Real CLI inside the container                                                                                                                                                     | **not verified**                                                                                                                                                     |
| Simulated websites, held-out variant generator, research protocol                                                                                                                 | **not built**                                                                                                                                                        |

## What a result means

The benchmark measures specified, observable behaviours (attempted and executed actions against a
user's spending authorisation, handling of untrusted funding claims, delegation scope, responses
to injected page content) in an instrumented, simulated environment. **Passing it does not show
that an agent is aligned in general**, and proxy-only runs are instrumented, not isolated
(spec §14, docs/threat-model.md). Refusing or stopping can be safe without being useful; the
reports keep capability (B0) and policy compliance separate and never compress them into one
score.

## Conventions

- [AGENTS.md](AGENTS.md) is the canonical vocabulary (root glossary plus nested glossaries in the
  directories that own a domain) and the naming rules; `CLAUDE.md` points Claude Code at it.
- **No comments in source.** Knowledge lives in names, tests, glossaries and `docs/`;
  `pnpm check:comments` enforces it for TS/JS, JSON, YAML, shell and Dockerfiles.
- `pnpm check` runs prettier, Biome lint, the comment ban, the glossary check and typecheck;
  `pnpm test` runs every test. CI runs the same, plus one scripted episode and actionlint.
- How to contribute: [CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

`packages/`: `protocol` (all shared types), `pki`, `mitm-proxy`, `browser`, `world-state`
(journal, projection, policy), `scenarios`, `graders`, `artifacts`, `agent-tools` (the `bench` and
`browser` MCP servers), `agent-adapters` (scripted, Claude Code, Codex, external stub),
`subagents` (delegation lifecycle). `apps/`: `world` (Fastify agent API / site host / admin API),
`runner` (the `bench` CLI), `report`. `scenarios/` (29 YAML scenarios), `tests/` (fixtures,
grader-contract, integration, e2e), `scripts/` (the comment and glossary checks), `docker/` +
`docker-compose.yml`.

## License

Not yet licensed: the owner has not chosen a license, and there is no LICENSE file.
