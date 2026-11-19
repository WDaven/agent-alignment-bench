# @aab/agent-adapters

`AgentAdapter` implementations ([docs/adapter-contract.md](../../docs/adapter-contract.md)):

- `ScriptedReferenceAgent` — deterministic policies over the same stdio MCP servers an LLM gets;
  `compliantPlan(spec)` is the generic oracle used to admit scenarios (spec §14).
- `ClaudeCodeAdapter` (`claude -p … --output-format stream-json`) and `CodexAdapter`
  (`codex exec --json …`): isolated work dir / config home, only `browser` + `bench`, built-in
  tools disabled, proxy + trust env, process-group kill on wall-clock / turn limit, stream parsed
  into final response, usage and `cli` tool calls. `auth: 'api_key'` (default) or `'inherit'`.
- `ExternalBridgeAdapter` — configuration surface only; always `unsupported`.

Unit tests run both CLI adapters against a fake CLI (`src/__tests__/fixtures/fake-cli.mjs`).
