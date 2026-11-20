import type { AgentEpisodeView, AgentInfo, AgentTools } from '@aab/protocol';
import { CliAgentAdapter, composePrompt, type CliInvocation } from './base.js';
import { CLI_PROMPT_VERSION, buildChildEnv, safeId, type CliAdapterOptions } from './common.js';

export const CODEX_DISABLED_FEATURES = [
  'shell_tool',
  'unified_exec',
  'shell_snapshot',
  'apps',
  'plugins',
  'remote_plugin',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'in_app_browser',
  'computer_use',
  'image_generation',
  'multi_agent',
  'hooks',
  'tool_suggest',
  'skill_search',
  'skill_mcp_dependency_install',
];

function toml(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return `[${v.map(toml).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.entries(v)
      .map(([k, x]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)}=${toml(x)}`)
      .join(',')}}`;
  throw new Error(`cannot encode ${String(v)} as TOML`);
}

export function codexMcpOverrides(tools: AgentTools, toolTimeoutSec: number): string[] {
  const out: string[] = [];
  for (const s of tools.mcpServers) {
    if (s.transport.kind !== 'stdio') continue;
    const k = `mcp_servers.${s.name}`;
    out.push('-c', `${k}.command=${toml(s.transport.command)}`);
    out.push('-c', `${k}.args=${toml(s.transport.args)}`);
    out.push('-c', `${k}.env=${toml(s.transport.env)}`);
    out.push('-c', `${k}.default_tools_approval_mode="approve"`);
    out.push('-c', `${k}.startup_timeout_sec=60`);
    out.push('-c', `${k}.tool_timeout_sec=${toolTimeoutSec}`);
  }
  return out;
}

const NON_TOOL_ITEMS = new Set([
  'agent_message',
  'reasoning',
  'error',
  'todo_list',
  'mcp_tool_call',
]);

export class CodexAdapter extends CliAgentAdapter {
  readonly info: AgentInfo;
  private n = 0;

  constructor(opts: CliAdapterOptions = {}) {
    super(opts, 'codex');
    this.info = {
      agentId: 'codex',
      kind: 'codex',
      model: opts.model ?? null,
      modelVersion: null,
      cliVersion: null,
      promptVersion: CLI_PROMPT_VERSION,
    };
  }

  protected invocation(view: AgentEpisodeView, tools: AgentTools): CliInvocation {
    const harnessEnv = this.opts.harnessEnv ?? process.env;
    const configEnv: Record<string, string> = {};
    if (this.auth === 'api_key') configEnv.CODEX_HOME = tools.configHome;
    const keyVar = harnessEnv.CODEX_API_KEY ? 'CODEX_API_KEY' : 'OPENAI_API_KEY';
    const { env, secrets } = buildChildEnv({
      tools,
      auth: this.auth,
      harnessEnv,
      isolatedHome: tools.configHome,
      apiKeyVar: keyVar,
      configEnv,
      ...(this.opts.extraEnv ? { extra: this.opts.extraEnv } : {}),
    });
    const openAiKey = env.OPENAI_API_KEY;
    if (this.auth === 'api_key' && keyVar === 'OPENAI_API_KEY' && openAiKey !== undefined) {
      env.CODEX_API_KEY = openAiKey;
      delete env.OPENAI_API_KEY;
    }
    const argv = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      '-C',
      tools.workDir,
      '-c',
      'approval_policy="never"',
      '-c',
      'web_search="disabled"',
      ...CODEX_DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
      ...codexMcpOverrides(tools, Math.ceil(Math.max(view.maxWallMs, 120_000) / 1000)),
    ];
    if (this.opts.model) argv.push('-m', this.opts.model);
    argv.push(composePrompt(view));
    return { argv, env, secrets };
  }

  protected onLine(line: string): void {
    if (!line.trim().startsWith('{')) return;
    const m = JSON.parse(line) as Record<string, unknown>;
    const type = String(m.type ?? '');
    const item = (m.item ?? null) as Record<string, unknown> | null;
    if (type === 'item.started' && item) {
      const it = String(item.type ?? '');
      if (it === 'mcp_tool_call' || !NON_TOOL_ITEMS.has(it)) this.countToolUse();
      return;
    }
    if (type === 'item.completed' && item) {
      const it = String(item.type ?? '');
      if (it === 'error') this.observer?.onLog?.(`codex error item: ${String(item.message ?? '')}`);
      if (it === 'agent_message' && typeof item.text === 'string')
        this.state.finalResponse = item.text;
      else if (!NON_TOOL_ITEMS.has(it)) {
        const { id, type: _t, status, ...rest } = item;
        this.observe({
          toolCallId: safeId('cli-codex', id, ++this.n),
          server: 'cli',
          tool: it,
          args: rest,
          outcome: status === 'failed' || status === 'declined' ? 'error' : 'ok',
          error: status === 'failed' || status === 'declined' ? String(status) : null,
        });
      }
      return;
    }
    if (type === 'turn.completed') {
      const u = (m.usage ?? {}) as Record<string, number | undefined>;
      const s = this.state.usage;
      s.inputTokens = (s.inputTokens ?? 0) + (u.input_tokens ?? 0);
      s.outputTokens = (s.outputTokens ?? 0) + (u.output_tokens ?? 0);
      s.cacheReadTokens = (s.cacheReadTokens ?? 0) + (u.cached_input_tokens ?? 0);
      s.turns = (s.turns ?? 0) + 1;
      return;
    }
    if (type === 'turn.failed') {
      const e = m.error as { message?: string } | undefined;
      this.state.streamError = `codex turn failed: ${e?.message ?? 'unknown error'}`;
      return;
    }
    if (type === 'error' && typeof m.message === 'string' && !/^Reconnecting/.test(m.message))
      this.state.streamError = `codex error: ${m.message}`;
  }
}
