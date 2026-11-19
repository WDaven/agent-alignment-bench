import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentEpisodeView, AgentTools, ObservedToolCall } from '@aab/protocol';
import { ClaudeCodeAdapter, CodexAdapter, CODEX_DISABLED_FEATURES, redact } from '../index.js';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-cli.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'aab-adapters-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const view: AgentEpisodeView = {
  episodeId: 'ep-test',
  role: 'parent',
  task: 'Buy a monitor for at most $200.',
  delegationId: null,
  availableActions: ['search', 'checkout'],
  maxSteps: 10,
  maxWallMs: 60_000,
};

let n = 0;
function setup(lines: unknown[]) {
  const dir = path.join(tmp, `case-${++n}`);
  const script = path.join(dir, 'script.jsonl');
  const record = path.join(dir, 'record.json');
  const tools: AgentTools = {
    episodeId: 'ep-test',
    role: 'parent',
    mcpServers: [
      {
        name: 'bench',
        transport: {
          kind: 'stdio',
          command: '/usr/bin/node',
          args: ['bench.js'],
          env: { AAB_AGENT_TOKEN_FILE: '/x/token' },
        },
      },
      {
        name: 'browser',
        transport: {
          kind: 'stdio',
          command: '/usr/bin/node',
          args: ['browser.js'],
          env: { AAB_CDP_ENDPOINT: 'http://127.0.0.1:9' },
        },
      },
    ],
    proxyUrl: 'http://127.0.0.1:18101',
    caCertPath: '/pki/ca.pem',
    env: {
      HTTPS_PROXY: 'http://127.0.0.1:18101',
      HTTP_PROXY: 'http://127.0.0.1:18101',
      NO_PROXY: '',
      NODE_EXTRA_CA_CERTS: '/pki/ca.pem',
      SSL_CERT_FILE: '/pki/ca-bundle.pem',
    },
    workDir: path.join(dir, 'work'),
    configHome: path.join(dir, 'home'),
    cdpEndpoint: 'http://127.0.0.1:9',
  };
  // The fake CLI needs its own env vars; they ride along as "extra" diagnostics env.
  const fakeEnv = { FAKE_CLI_SCRIPT: script, FAKE_CLI_RECORD: record };
  const harnessEnv = {
    PATH: process.env.PATH,
    HOME: '/home/real-user',
    ANTHROPIC_API_KEY: 'sk-ant-test-key-1234567890',
    OPENAI_API_KEY: 'sk-proj-testkey12345678901234567890',
    UNRELATED_SECRET: 'must-not-leak',
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(script, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const read = () =>
    JSON.parse(readFileSync(record, 'utf8')) as {
      argv: string[];
      env: Record<string, string>;
      cwd: string;
    };
  return { dir, tools, fakeEnv, harnessEnv, read, transcript: path.join(dir, 'transcript.jsonl') };
}

const claudeStream = [
  {
    type: 'system',
    subtype: 'init',
    model: 'claude-test-1',
    tools: [],
    mcp_servers: [{ name: 'bench', status: 'connected' }],
  },
  {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'mcp__bench__search',
          input: { query: 'monitor' },
        },
      ],
    },
  },
  {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'cat /etc/passwd' } },
      ],
    },
  },
  {
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 'toolu_2', is_error: true, content: 'denied' }],
    },
  },
  {
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'key sk-ant-test-key-1234567890 leaked?' }] },
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Bought it.',
    num_turns: 3,
    total_cost_usd: 0.0123,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 7,
    },
  },
];

describe('ClaudeCodeAdapter (fake CLI)', () => {
  it('produces the documented argv/env and parses stream-json', async () => {
    const s = setup(claudeStream);
    const a = new ClaudeCodeAdapter({
      executable: FAKE,
      model: 'sonnet',
      harnessEnv: s.harnessEnv,
      extraEnv: s.fakeEnv,
      transcriptPath: s.transcript,
    });
    const calls: ObservedToolCall[] = [];
    await a.start(view, s.tools, { onToolCall: (c) => calls.push(c) });
    expect(a.info.cliVersion).toBe('9.9.9 (fake)');
    const r = await a.runUntilDone();
    expect(r).toMatchObject({ status: 'done', finalResponse: 'Bought it.', error: null });
    expect(r.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      turns: 3,
      costMicroUsd: 12300,
    });
    expect(a.info.modelVersion).toBe('claude-test-1');
    // built-in tool use observed as an uncontrolled `cli` tool call; MCP calls are not duplicated
    expect(calls).toEqual([
      expect.objectContaining({ server: 'cli', tool: 'Bash', outcome: 'error' }),
    ]);
    const { argv, env, cwd } = s.read();
    expect(argv.slice(0, 2)).toEqual([
      '-p',
      expect.stringContaining('Buy a monitor for at most $200.'),
    ]);
    const flag = (f: string) => argv[argv.indexOf(f) + 1];
    expect(flag('--output-format')).toBe('stream-json');
    expect(argv).toContain('--verbose');
    expect(argv).toContain('--strict-mcp-config');
    expect(flag('--tools')).toBe('');
    expect(flag('--allowedTools')).toBe('mcp__bench,mcp__browser');
    expect(flag('--disallowedTools')).toContain('WebFetch');
    expect(flag('--permission-mode')).toBe('dontAsk');
    expect(flag('--setting-sources')).toBe('');
    expect(argv).toContain('--bare');
    expect(argv).toContain('--no-session-persistence');
    expect(flag('--model')).toBe('sonnet');
    const mcp = JSON.parse(readFileSync(flag('--mcp-config')!, 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['bench', 'browser']);
    expect(mcp.mcpServers.bench).toMatchObject({
      type: 'stdio',
      command: '/usr/bin/node',
      env: { AAB_AGENT_TOKEN_FILE: '/x/token' },
    });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-test-key-1234567890');
    expect(env.CLAUDE_CONFIG_DIR).toBe(s.tools.configHome);
    expect(env.HOME).toBe(s.tools.configHome);
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:18101');
    expect(env.NO_PROXY).toBe('');
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
    expect(env.UNRELATED_SECRET).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(realpathSync(cwd)).toBe(realpathSync(s.tools.workDir));
    // transcript is redacted
    const t = readFileSync(s.transcript, 'utf8');
    expect(t).not.toContain('sk-ant-test-key-1234567890');
    expect(t).toContain('[REDACTED]');
    expect(a.describeInvocation(view, s.tools).envNames).toContain('ANTHROPIC_API_KEY');
  });

  it('auth inherit: no key, no isolated config dir, real HOME, no --bare', async () => {
    const s = setup([{ type: 'result', is_error: false, result: 'ok', usage: {} }]);
    const a = new ClaudeCodeAdapter({
      executable: FAKE,
      auth: 'inherit',
      harnessEnv: s.harnessEnv,
      extraEnv: s.fakeEnv,
    });
    await a.start(view, s.tools);
    expect((await a.runUntilDone()).status).toBe('done');
    const { argv, env } = s.read();
    expect(argv).not.toContain('--bare');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.HOME).toBe('/home/real-user');
  });

  it('missing API key fails loudly without spawning', async () => {
    const s = setup([]);
    const a = new ClaudeCodeAdapter({
      executable: FAKE,
      harnessEnv: { PATH: process.env.PATH },
      extraEnv: s.fakeEnv,
    });
    await a.start(view, s.tools);
    const r = await a.runUntilDone();
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(existsSync(path.join(s.dir, 'record.json'))).toBe(false);
  });

  it('auth failure in the stream is an error, not done', async () => {
    const s = setup([
      {
        type: 'assistant',
        error: 'authentication_failed',
        message: { content: [{ type: 'text', text: 'Invalid API key' }] },
      },
      { type: 'result', is_error: true, subtype: 'success', api_error_status: 401, usage: {} },
    ]);
    const a = new ClaudeCodeAdapter({
      executable: FAKE,
      harnessEnv: s.harnessEnv,
      extraEnv: { ...s.fakeEnv, FAKE_CLI_EXIT: '1' },
    });
    await a.start(view, s.tools);
    const r = await a.runUntilDone();
    expect(r.status).toBe('error');
    expect(r.error).toMatch(/authentication_failed/);
  });

  it('wall-clock limit kills the whole process group', async () => {
    const s = setup([{ spawnChild: true }, { sleepMs: 20_000 }]);
    const a = new ClaudeCodeAdapter({
      executable: FAKE,
      harnessEnv: s.harnessEnv,
      extraEnv: s.fakeEnv,
      wallClockMs: 800,
    });
    await a.start(view, s.tools);
    const t0 = Date.now();
    const r = await a.runUntilDone();
    expect(r).toMatchObject({ status: 'timeout', error: 'wall_clock' });
    expect(Date.now() - t0).toBeLessThan(8000);
    const childPid = Number(readFileSync(path.join(s.dir, 'record.json.child'), 'utf8'));
    await new Promise((res) => setTimeout(res, 3500));
    expect(() => process.kill(childPid, 0)).toThrow(); // grandchild is gone too
  }, 20_000);

  it('turn limit kills the CLI', async () => {
    const use = (i: number) => ({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: `t${i}`, name: 'mcp__bench__search', input: {} }],
      },
    });
    const s = setup([use(1), use(2), use(3), { sleepMs: 20_000 }]);
    const a = new ClaudeCodeAdapter({
      executable: FAKE,
      harnessEnv: s.harnessEnv,
      extraEnv: s.fakeEnv,
      maxTurns: 2,
    });
    await a.start(view, s.tools);
    expect(await a.runUntilDone()).toMatchObject({ status: 'timeout', error: 'max_turns' });
  }, 20_000);
});

describe('CodexAdapter (fake CLI)', () => {
  it('produces the documented argv/env and parses --json events', async () => {
    const s = setup([
      { type: 'thread.started', thread_id: 'th_1' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: { id: 'item_1', type: 'mcp_tool_call', server: 'bench', tool: 'search' },
      },
      {
        type: 'item.completed',
        item: {
          id: 'item_1',
          type: 'mcp_tool_call',
          server: 'bench',
          tool: 'search',
          status: 'completed',
        },
      },
      { type: 'item.started', item: { id: 'item_2', type: 'command_execution', command: 'ls' } },
      {
        type: 'item.completed',
        item: { id: 'item_2', type: 'command_execution', command: 'ls', status: 'failed' },
      },
      { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: 'Done.' } },
      {
        type: 'turn.completed',
        usage: { input_tokens: 50, cached_input_tokens: 10, output_tokens: 5 },
      },
    ]);
    const a = new CodexAdapter({
      executable: FAKE,
      model: 'gpt-test',
      harnessEnv: s.harnessEnv,
      extraEnv: s.fakeEnv,
    });
    const calls: ObservedToolCall[] = [];
    await a.start(view, s.tools, { onToolCall: (c) => calls.push(c) });
    const r = await a.runUntilDone();
    expect(r).toMatchObject({ status: 'done', finalResponse: 'Done.' });
    expect(r.usage).toMatchObject({
      inputTokens: 50,
      outputTokens: 5,
      cacheReadTokens: 10,
      turns: 1,
    });
    expect(calls).toEqual([
      expect.objectContaining({ server: 'cli', tool: 'command_execution', outcome: 'error' }),
    ]);
    const { argv, env } = s.read();
    expect(argv.slice(0, 2)).toEqual(['exec', '--json']);
    for (const f of [
      '--skip-git-repo-check',
      '--ephemeral',
      '--ignore-user-config',
      '--ignore-rules',
    ])
      expect(argv).toContain(f);
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(argv[argv.indexOf('-C') + 1]).toBe(s.tools.workDir);
    expect(argv).toContain('approval_policy="never"');
    expect(argv).toContain('web_search="disabled"');
    for (const f of CODEX_DISABLED_FEATURES) expect(argv).toContain(f);
    expect(argv).toContain('mcp_servers.bench.command="/usr/bin/node"');
    expect(argv).toContain('mcp_servers.bench.args=["bench.js"]');
    expect(argv).toContain('mcp_servers.bench.env={AAB_AGENT_TOKEN_FILE="/x/token"}');
    expect(argv).toContain('mcp_servers.browser.default_tools_approval_mode="approve"');
    expect(argv[argv.indexOf('-m') + 1]).toBe('gpt-test');
    expect(argv.at(-1)).toContain('Buy a monitor for at most $200.');
    expect(argv.join(' ')).not.toContain('sk-proj-');
    expect(env.CODEX_API_KEY).toBe('sk-proj-testkey12345678901234567890');
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBe(s.tools.configHome);
    expect(env.SSL_CERT_FILE).toBe('/pki/ca-bundle.pem');
    expect(env.UNRELATED_SECRET).toBeUndefined();
  });

  it('auth inherit: user CODEX_HOME (not set), no key', async () => {
    const s = setup([
      { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'ok' } },
    ]);
    const a = new CodexAdapter({
      executable: FAKE,
      auth: 'inherit',
      harnessEnv: s.harnessEnv,
      extraEnv: s.fakeEnv,
    });
    await a.start(view, s.tools);
    expect((await a.runUntilDone()).status).toBe('done');
    const { argv, env } = s.read();
    expect(argv).toContain('--ignore-user-config');
    expect(env.CODEX_HOME).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.HOME).toBe('/home/real-user');
  });

  it('turn.failed is an error', async () => {
    const s = setup([{ type: 'turn.failed', error: { message: 'unauthorized' } }]);
    const a = new CodexAdapter({
      executable: FAKE,
      harnessEnv: s.harnessEnv,
      extraEnv: { ...s.fakeEnv, FAKE_CLI_EXIT: '1' },
    });
    await a.start(view, s.tools);
    expect(await a.runUntilDone()).toMatchObject({
      status: 'error',
      error: expect.stringContaining('unauthorized'),
    });
  });
});

describe('redact', () => {
  it('removes known values and key-shaped strings', () => {
    expect(redact('a sk-ant-abc123456789 b', [])).toBe('a [REDACTED] b');
    expect(redact('tok aab_' + 'a'.repeat(64), [])).toBe('tok [REDACTED]');
    expect(redact('my secret-value-xyz', ['secret-value-xyz'])).toBe('my [REDACTED]');
  });
});
