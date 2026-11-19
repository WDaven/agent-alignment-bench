/**
 * Claude Code adapter (`claude -p`). Flags verified against the installed `claude --help`
 * (2.1.224):
 *
 *   claude -p <prompt> --output-format stream-json --verbose
 *          --mcp-config <configHome>/mcp.json --strict-mcp-config
 *          --tools ""                       # no built-in tools at all (init shows tools: [])
 *          --allowedTools mcp__browser,mcp__bench --permission-mode dontAsk
 *          --disallowedTools <built-ins>    # defence in depth
 *          --setting-sources "" --disable-slash-commands --no-chrome --no-session-persistence
 *          [--bare] (api_key mode: no OAuth/keychain, no hooks/plugins/CLAUDE.md discovery)
 *          [--model <m>] [--max-budget-usd <n>]
 *
 * Env: sanitised base + AgentTools.env (HTTPS_PROXY/HTTP_PROXY to the CLI listener, NO_PROXY='',
 * trustEnv()) + AGENT_CLI_QUIET_ENV + CLAUDE_CONFIG_DIR (api_key mode) + ANTHROPIC_API_KEY
 * (api_key mode) + MCP_TIMEOUT / MCP_TOOL_TIMEOUT. `--max-turns` does not exist in this version;
 * the turn cap is enforced by counting tool_use blocks in the stream and killing the group.
 *
 * Verified with a fake key (no model call): model-API traffic goes through HTTPS_PROXY as
 * `network.tunnel` to api.anthropic.com; MCP children inherit the CLI's FULL environment
 * (including ANTHROPIC_API_KEY) — Claude Code does not sanitise it, so our servers never expose env.
 */
import type { AgentEpisodeView, AgentInfo, AgentTools } from '@aab/protocol';
import { CliAgentAdapter, composePrompt, type CliInvocation } from './base.js';
import { CLI_PROMPT_VERSION, buildChildEnv, safeId, type CliAdapterOptions } from './common.js';

/** Built-in tools explicitly denied in addition to `--tools ""`. */
export const CLAUDE_DISALLOWED_TOOLS = [
  'Bash',
  'BashOutput',
  'KillShell',
  'Edit',
  'MultiEdit',
  'Write',
  'Read',
  'NotebookEdit',
  'Glob',
  'Grep',
  'LS',
  'WebFetch',
  'WebSearch',
  'Task',
  'Agent',
  'TodoWrite',
  'Skill',
  'SlashCommand',
  'ExitPlanMode',
];

export function claudeMcpConfig(tools: AgentTools): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of tools.mcpServers) {
    if (s.transport.kind !== 'stdio') continue;
    mcpServers[s.name] = {
      type: 'stdio',
      command: s.transport.command,
      args: s.transport.args,
      env: s.transport.env,
    };
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}

export class ClaudeCodeAdapter extends CliAgentAdapter {
  readonly info: AgentInfo;
  private pending = new Map<string, { tool: string; args: unknown; n: number }>();

  constructor(opts: CliAdapterOptions = {}) {
    super(opts, 'claude');
    this.info = {
      agentId: 'claude-code',
      kind: 'claude_code',
      model: opts.model ?? null,
      modelVersion: null,
      cliVersion: null,
      promptVersion: CLI_PROMPT_VERSION,
    };
  }

  protected invocation(view: AgentEpisodeView, tools: AgentTools): CliInvocation {
    const mcpPath = this.writeConfigFile(tools, 'mcp.json', claudeMcpConfig(tools));
    const harnessEnv = this.opts.harnessEnv ?? process.env;
    const configEnv: Record<string, string> = {
      MCP_TIMEOUT: '60000',
      // `delegate` waits for the child agent; allow long tool calls.
      MCP_TOOL_TIMEOUT: String(Math.max(view.maxWallMs, 120_000)),
    };
    if (this.auth === 'api_key') configEnv.CLAUDE_CONFIG_DIR = tools.configHome;
    const { env, secrets } = buildChildEnv({
      tools,
      auth: this.auth,
      harnessEnv,
      isolatedHome: tools.configHome,
      apiKeyVar: 'ANTHROPIC_API_KEY',
      configEnv,
      ...(this.opts.extraEnv ? { extra: this.opts.extraEnv } : {}),
    });
    const argv = [
      '-p',
      composePrompt(view),
      '--output-format',
      'stream-json',
      '--verbose',
      '--mcp-config',
      mcpPath,
      '--strict-mcp-config',
      '--tools',
      '',
      '--allowedTools',
      tools.mcpServers.map((s) => `mcp__${s.name}`).join(','),
      '--disallowedTools',
      CLAUDE_DISALLOWED_TOOLS.join(','),
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      '',
      '--disable-slash-commands',
      '--no-chrome',
      '--no-session-persistence',
    ];
    if (this.auth === 'api_key') argv.push('--bare');
    if (this.opts.model) argv.push('--model', this.opts.model);
    if (this.opts.maxBudgetUsd) argv.push('--max-budget-usd', String(this.opts.maxBudgetUsd));
    return { argv, env, secrets };
  }

  protected onLine(line: string): void {
    if (!line.trim().startsWith('{')) return;
    const m = JSON.parse(line) as Record<string, unknown>;
    const type = m.type;
    if (type === 'system' && m.subtype === 'init') {
      this.state.modelVersion = typeof m.model === 'string' ? m.model : null;
      (this.info as { modelVersion: string | null }).modelVersion = this.state.modelVersion;
      const builtins = Array.isArray(m.tools)
        ? (m.tools as string[]).filter((t) => !t.startsWith('mcp__'))
        : [];
      if (builtins.length)
        this.observer?.onLog?.(`claude init lists built-in tools: ${builtins.join(', ')}`);
      const failed = Array.isArray(m.mcp_servers)
        ? (m.mcp_servers as { name: string; status: string }[]).filter(
            (s) => s.status !== 'connected',
          )
        : [];
      if (failed.length)
        this.observer?.onLog?.(
          `claude MCP servers not connected: ${failed.map((s) => `${s.name}=${s.status}`).join(', ')}`,
        );
      return;
    }
    const message = m.message as { content?: unknown[] } | undefined;
    if (type === 'assistant' && Array.isArray(message?.content)) {
      for (const c of message.content as Record<string, unknown>[]) {
        if (c.type === 'tool_use') {
          this.countToolUse();
          const name = String(c.name ?? '');
          if (!name.startsWith('mcp__'))
            this.pending.set(String(c.id), {
              tool: name,
              args: c.input ?? null,
              n: this.pending.size + 1,
            });
        } else if (c.type === 'text' && typeof c.text === 'string' && m.error) {
          this.state.streamError = `${String(m.error)}: ${c.text}`;
        }
      }
      return;
    }
    if (type === 'user' && Array.isArray(message?.content)) {
      for (const c of message.content as Record<string, unknown>[]) {
        if (c.type !== 'tool_result') continue;
        const p = this.pending.get(String(c.tool_use_id));
        if (!p) continue;
        this.pending.delete(String(c.tool_use_id));
        this.observe({
          toolCallId: safeId('cli-claude', c.tool_use_id, p.n),
          server: 'cli',
          tool: p.tool,
          args: p.args,
          outcome: c.is_error ? 'error' : 'ok',
          error: c.is_error ? String(JSON.stringify(c.content ?? '')).slice(0, 500) : null,
        });
      }
      return;
    }
    if (type === 'result') {
      if (typeof m.result === 'string') this.state.finalResponse = m.result;
      const u = (m.usage ?? {}) as Record<string, number | undefined>;
      const s = this.state.usage;
      s.inputTokens = u.input_tokens ?? s.inputTokens;
      s.outputTokens = u.output_tokens ?? s.outputTokens;
      s.cacheReadTokens = u.cache_read_input_tokens ?? s.cacheReadTokens;
      s.cacheWriteTokens = u.cache_creation_input_tokens ?? s.cacheWriteTokens;
      s.turns = typeof m.num_turns === 'number' ? m.num_turns : s.turns;
      if (typeof m.total_cost_usd === 'number') s.costMicroUsd = Math.round(m.total_cost_usd * 1e6);
      if (m.is_error === true)
        this.state.streamError ??= `claude reported an error (${String(m.subtype)}${m.api_error_status ? `, HTTP ${String(m.api_error_status)}` : ''})`;
    }
  }
}
