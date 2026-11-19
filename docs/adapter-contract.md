# Adapter contract (`AgentAdapter`, `@aab/agent-adapters`)

An adapter runs ONE agent for ONE role of ONE episode. The protocol interface
(`packages/protocol/src/agent.ts`):

```ts
interface AgentAdapter {
  readonly info: AgentInfo; // agentId, kind, model, modelVersion, cliVersion, promptVersion
  readonly capabilities: AdapterCapabilities; // see below
  start(view: AgentEpisodeView, tools: AgentTools, observer?: AgentObserver): Promise<void>;
  runUntilDone(): Promise<AgentRunResult>; // status done | timeout | error, finalResponse, usage
  stop(): Promise<void>; // idempotent; kills every child process
}
```

`view` is all the agent may know (task text, role, delegation id, its available actions, limits —
never scenario id, variant, seed or any `expected` value). `tools` is what the harness provides:
the two stdio MCP servers (`browser`, `bench`), the role's CLI proxy listener, the trust env, an
empty work dir and an isolated config home.

## What an adapter must declare as controllable (spec §3, §5)

```ts
capabilities = {
  browser: 'harness' | 'uncontrolled' | 'none', // whose browser renders pages
  search: 'harness' | 'uncontrolled' | 'none', // whose search answers queries
  otherTools: 'harness' | 'uncontrolled' | 'none', // shell, web fetch, file edit, code exec ... after disabling
  supportsDelegation: boolean,
};
```

- `harness`: every request on that path goes through the harness (the `browser` MCP server and
  Chromium on the role's intercept-only proxy listener; the `bench` MCP server for world ops).
- `none`: the path does not exist for this agent (e.g. built-in tools disabled by flags).
- `uncontrolled`: the agent can browse, search or act through something the harness does not
  route (a vendor-hosted browser, provider-side web search, an unrestricted shell).

The runner refuses to run an adapter for which `isFullyControlled(capabilities)` is false and
records `support: 'unsupported'` — such an agent cannot get a reliable end-to-end grade, and the
harness says so instead of reporting grades that look complete. Declared `none` is enforced where
possible and checked where not: any built-in tool that still shows up in the CLI's own output
stream is journaled as `tool.call` with `server: 'cli'` and graded as the harness violation
`uncontrolled_tool_used`.

## CLI adapters (Claude Code, Codex)

Requirements (implemented in `packages/agent-adapters/src/cli/`):

1. Non-interactive, the user task as the prompt, prefixed by a short versioned harness note
   (`promptVersion: cli-task/1`, identical for both CLIs).
2. MCP config exposing only `browser` and `bench`; permission prompts off for exactly those.
3. Built-in tools (web fetch/search, shell, file edit, subagents, browser/computer use, plugins,
   hooks) disabled by flags.
4. Isolated empty working directory and (api_key mode) isolated config home and HOME.
5. Sanitised environment: PATH/LANG/USER/SHELL, the proxy + trust env of `AgentTools`
   (`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` → the role's CLI listener, `NO_PROXY=`, `trustEnv()`),
   `AGENT_CLI_QUIET_ENV`, and — api_key mode only — the one API key the CLI needs.
6. Wall-clock and tool-call limits; the CLI is spawned in its own process group and the whole
   group (CLI + MCP servers + anything they started) is killed (SIGTERM, then SIGKILL).
7. Structured output (`stream-json` / `--json`) parsed into `agent.final_response`, built-in tool
   uses (→ `tool.call` `cli`) and token/cost usage. MCP tool calls are journaled by the MCP servers.
8. Credentials are never copied, printed or logged. The redacted transcript
   (`runs/<id>/transcripts/<role>.jsonl`) has key-shaped strings and known secret values removed.
   The world bearer token reaches the MCP servers only as a path to a 0600 file.

### Auth

- `api_key` (default): `ANTHROPIC_API_KEY` (Claude) / `CODEX_API_KEY` or `OPENAI_API_KEY`
  (Codex; passed as `CODEX_API_KEY`) is read from the harness env and given to the child. Missing
  key ⇒ the run fails loudly before spawning.
- `inherit` (`--auth inherit`, explicit opt-in): the user's existing CLI login. The config home
  is then the user's (`~/.claude` / `~/.codex`) because that is where the login lives (Claude Code
  keys its keychain entry by config dir). Isolation is reduced and recorded (`authMode: inherit`):
  Claude Code skips user settings/hooks (`--setting-sources ""`), Codex skips `config.toml`
  (`--ignore-user-config`), but user-level instruction files (`~/.claude/CLAUDE.md`,
  `~/.codex/AGENTS.md`) may still be loaded by the CLI.

### Exact invocations (from the installed `--help`, claude 2.1.224 / codex-cli 0.169.0)

Claude Code:

```text
claude -p <prompt> --output-format stream-json --verbose
       --mcp-config <configHome>/mcp.json --strict-mcp-config
       --tools "" --allowedTools mcp__bench,mcp__browser
       --disallowedTools Bash,BashOutput,KillShell,Edit,MultiEdit,Write,Read,NotebookEdit,Glob,Grep,LS,WebFetch,WebSearch,Task,Agent,TodoWrite,Skill,SlashCommand,ExitPlanMode
       --permission-mode dontAsk --setting-sources "" --disable-slash-commands --no-chrome
       --no-session-persistence [--bare (api_key)] [--model <m>] [--max-budget-usd <x>]
env: PATH LANG USER LOGNAME SHELL TZ TERM NO_COLOR HOME TMPDIR HTTPS_PROXY HTTP_PROXY https_proxy
     http_proxy ALL_PROXY NO_PROXY no_proxy NODE_EXTRA_CA_CERTS SSL_CERT_FILE CODEX_CA_CERTIFICATE
     REQUESTS_CA_BUNDLE CURL_CA_BUNDLE GIT_SSL_CAINFO NPM_CONFIG_CAFILE CARGO_HTTP_CAINFO AWS_CA_BUNDLE
     DENO_CERT CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC DISABLE_AUTOUPDATER DISABLE_TELEMETRY
     DISABLE_ERROR_REPORTING DISABLE_BUG_COMMAND CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY MCP_TIMEOUT
     MCP_TOOL_TIMEOUT [CLAUDE_CONFIG_DIR ANTHROPIC_API_KEY (api_key mode)]
```

`--max-turns` does not exist in 2.1.224; the turn cap counts `tool_use` blocks in the stream.

Codex:

```text
codex exec --json --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules
           --sandbox read-only -C <workDir> -c approval_policy="never" -c web_search="disabled"
           --disable shell_tool --disable unified_exec --disable shell_snapshot --disable apps
           --disable plugins --disable remote_plugin --disable browser_use --disable browser_use_external
           --disable browser_use_full_cdp_access --disable in_app_browser --disable computer_use
           --disable image_generation --disable multi_agent --disable hooks --disable tool_suggest
           --disable skill_search --disable skill_mcp_dependency_install
           -c mcp_servers.<bench|browser>.command="…" -c mcp_servers.<…>.args=[…]
           -c mcp_servers.<…>.env={AAB_AGENT_API_URL="…",AAB_AGENT_TOKEN_FILE="…",…}
           -c mcp_servers.<…>.default_tools_approval_mode="approve"
           -c mcp_servers.<…>.startup_timeout_sec=60 -c mcp_servers.<…>.tool_timeout_sec=<n>
           [-m <model>] <prompt>
env: same base/proxy/trust/quiet set as above + [CODEX_HOME CODEX_API_KEY (api_key mode)]
```

`code_mode_host` is deliberately NOT disabled: in 0.169.0 Codex routes model tool calls (MCP tools
included) through its code-mode host and fails closed without it (seen in the live smoke run).

### What was verified about each CLI (macOS, this repo)

|                                                   | Claude Code 2.1.224                                                              | Codex 0.169.0                                                                                                          |
| ------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Honours `HTTPS_PROXY` for model-API traffic       | yes — fake-key probe: 2 × `network.tunnel` api.anthropic.com on the CLI listener | yes — fake-key probe and live run: wss + https to api.openai.com / chatgpt.com as `network.tunnel` on the CLI listener |
| TLS inside the tunnel verifies with the trust env | yes (`NODE_EXTRA_CA_CERTS` adds to Node's roots)                                 | yes (`SSL_CERT_FILE` / `CODEX_CA_CERTIFICATE` = Mozilla roots + eval CA)                                               |
| API key env var                                   | `ANTHROPIC_API_KEY` (`apiKeySource: ANTHROPIC_API_KEY`)                          | `CODEX_API_KEY` (an `OPENAI_API_KEY` alone is NOT used by `codex exec`)                                                |
| Built-in tools after flags                        | init message lists only `mcp__bench__*` / `mcp__browser__*`                      | no `command_execution` / `web_search` items in the live run                                                            |
| MCP children's environment                        | NOT sanitised: the full CLI env (incl. `ANTHROPIC_API_KEY`) is inherited         | sanitised: PATH, HOME, the CA vars and the configured `env` only                                                       |
| Live episode                                      | not run: no usable CLI login on this machine and no API key                      | passed (`auth: inherit`, ChatGPT login)                                                                                |

## External agents (`ExternalBridgeAdapter`) — configuration surface only

`ExternalAgentConfig { agentId, model, endpoint, capabilities }` is where a controllable external
("Grok-style") agent would be described. Nothing about it is implemented or claimed: `start()`
always throws (`UnsupportedAgentError`), first because a declared uncontrolled path makes the
agent unsupported, otherwise because the transport is not written. To support such an agent
later, an adapter must (1) drive the harness browser through the `browser` MCP server or the
role's CDP endpoint, (2) send every world operation through the `bench` server / Agent API,
(3) disable or route all provider-side tools (hosted browsing/search/code), and (4) report its
final response and usage. Until that is independently demonstrated, report it as `unsupported`.
