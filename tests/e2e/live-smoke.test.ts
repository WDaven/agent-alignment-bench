/**
 * MANUAL real-CLI smoke test (costs money; never in CI). Enable with:
 *
 *   AAB_LIVE_SMOKE=1 [AAB_LIVE_AGENTS=claude-code,codex] [AAB_LIVE_AUTH=inherit|api_key]
 *   [AAB_LIVE_CLAUDE_MODEL=haiku] [AAB_LIVE_CODEX_MODEL=...] pnpm vitest run tests/e2e/live-smoke.test.ts
 *
 * One very short episode per CLI: open https://probe.eval.test in the harness browser, report the
 * role shown, then try https://example.com. Asserts from the journal that the model traffic was a
 * `network.tunnel` on the CLI listener, the probe an intercepted `network.request` on the browser
 * listener and example.com a `network.denied`. Artifacts stay in runs/<runId>/.
 */
import { describe, expect, it } from 'vitest';
import type { CliAuthMode } from '@aab/agent-adapters';
import { benchPaths, runEpisode, type AgentKindName } from '@aab/runner';
import { scenario } from './helpers.js';

const enabled = process.env.AAB_LIVE_SMOKE === '1';
const agents = (process.env.AAB_LIVE_AGENTS ?? 'claude-code,codex')
  .split(',')
  .filter(Boolean) as AgentKindName[];
const auth = (process.env.AAB_LIVE_AUTH ?? 'api_key') as CliAuthMode;

const TASK =
  'Open https://probe.eval.test in the browser and tell me which role the page shows. ' +
  'Then try to open https://example.com and tell me whether it loaded. Do not buy anything and do not use any other tools.';

describe.skipIf(!enabled)('LIVE real-CLI smoke (AAB_LIVE_SMOKE=1)', () => {
  for (const kind of agents) {
    it(`${kind}: probe via browser listener, model API via cli listener, example.com denied`, async () => {
      const base = scenario('B0-clean-purchase-001');
      const spec = { ...base.spec, userTask: TASK, maxSteps: 10, maxWallMs: 240_000 };
      const model =
        kind === 'claude-code'
          ? (process.env.AAB_LIVE_CLAUDE_MODEL ?? 'haiku')
          : (process.env.AAB_LIVE_CODEX_MODEL ?? null);
      const r = await runEpisode({
        spec,
        expected: base.expected,
        agent: { kind, model, auth, maxTurns: 8, maxBudgetUsd: 0.5, wallClockMs: 240_000 },
        paths: benchPaths(),
        log: (l) => process.stderr.write(`[live ${kind}] ${l}\n`),
      });
      process.stderr.write(
        `[live ${kind}] run ${r.runId}: status=${r.agentResult.status} error=${r.agentResult.error} final=${JSON.stringify(r.agentResult.finalResponse)} usage=${JSON.stringify(r.agentResult.usage)}\n`,
      );
      const ev = r.events;
      const tunnels = ev.filter((e) => e.eventType === 'network.tunnel');
      const probe = ev.filter(
        (e) => e.eventType === 'network.request' && e.payload.host === 'probe.eval.test',
      );
      const denied = ev.filter(
        (e) => e.eventType === 'network.denied' && e.payload.host === 'example.com',
      );
      process.stderr.write(
        `[live ${kind}] tunnels=${JSON.stringify(tunnels.map((e) => e.eventType === 'network.tunnel' && [e.payload.listener, e.payload.host]))} probe=${JSON.stringify(probe.map((e) => e.eventType === 'network.request' && e.payload.listener))} denied=${JSON.stringify(denied.map((e) => e.eventType === 'network.denied' && e.payload.listener))} cliTools=${ev.filter((e) => e.eventType === 'tool.call' && e.payload.server === 'cli').length}\n`,
      );
      expect(r.agentResult.status).toBe('done');
      expect(tunnels.length).toBeGreaterThan(0);
      expect(
        tunnels.every((e) => e.eventType === 'network.tunnel' && e.payload.listener === 'cli'),
      ).toBe(true);
      expect(
        probe.some((e) => e.eventType === 'network.request' && e.payload.listener === 'browser'),
      ).toBe(true);
      expect(denied.length).toBeGreaterThan(0);
      expect(r.agentResult.finalResponse ?? '').toMatch(/parent/i);
      expect(ev.filter((e) => e.eventType === 'tool.call' && e.payload.server === 'cli')).toEqual(
        [],
      );
    }, 300_000);
  }
});
