import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GRADER_VERSION, gradeEpisode, type EpisodeGradeResult } from '@aab/graders';
import {
  PROTOCOL_VERSION,
  isFullyControlled,
  type AgentAdapter,
  type AgentEpisodeView,
  type AgentObserver,
  type AgentRunResult,
  type AgentTools,
  type Episode,
  type McpServerSpec,
  type RunEvent,
  type RunMetadata,
  type ScenarioExpected,
  type ScenarioSpec,
  type WorldState,
} from '@aab/protocol';
import { ensureTrustMaterial, trustEnv } from '@aab/pki';
import { launchControlledBrowser, type ControlledBrowser } from '@aab/browser';
import { toolServerCommand, TOOL_ENV } from '@aab/agent-tools';
import { DelegationManager, type ChildLimits, type DelegationHost } from '@aab/subagents';
import { RunArtifacts, stableStringify } from '@aab/artifacts';
import { renderRunReport } from '@aab/report';
import type { WorldSitePlugin } from '@aab/world';
import { LocalBackend, type EndReason, type EpisodeBackend } from './backend.js';
import { createAdapter, presetsFor, type AgentSpec } from './agents.js';
import { benchPaths, newRunId, stableIdSecret, type BenchPaths } from './paths.js';

export interface RunEpisodeOptions {
  spec: ScenarioSpec;
  expected: ScenarioExpected;
  agent: AgentSpec;
  seed?: number;
  repetition?: number;
  suite?: string | null;
  headed?: boolean;
  browser?: boolean;
  paths?: BenchPaths;
  runId?: string;
  backend?: EpisodeBackend;
  childLimits?: ChildLimits;
  plugins?: readonly WorldSitePlugin[];
  onReady?: (ctx: LiveEpisode) => Promise<void> | void;
  log?: (line: string) => void;
}

export interface LiveEpisode {
  backend: EpisodeBackend;
  episode: Episode;
  runDir: string;
  tools: AgentTools;
  browser: ControlledBrowser | null;
  listeners: { browser: { port: number; url: string } | null; cli: { port: number; url: string } };
  scratch: string;
}

export interface EpisodeResult {
  runId: string;
  runDir: string;
  episode: Episode;
  agentResult: AgentRunResult;
  endReason: EndReason;
  grade: EpisodeGradeResult;
  events: RunEvent[];
  finalState: WorldState;
  meta: RunMetadata;
}

function gitCommit(root: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function envBuildHash(root: string): string {
  const commit = gitCommit(root) ?? 'nogit';
  let dirty = '';
  try {
    dirty = execFileSync('git', ['status', '--porcelain'], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
      ? '-dirty'
      : '';
  } catch {}
  return `${commit.slice(0, 12)}${dirty}+node${process.versions.node}+protocol${PROTOCOL_VERSION}`;
}

function episodeIdFor(p: BenchPaths, spec: ScenarioSpec, seed: number, repetition: number): string {
  const h = createHmac('sha256', stableIdSecret(p))
    .update(`aab-episode\u0000${spec.id}\u0000${seed}\u0000${repetition}`)
    .digest('hex')
    .slice(0, 16);
  return `ep-${h}`;
}

function writeSecretFile(file: string, value: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
}

interface RoleEnv {
  tools: AgentTools;
  browser: ControlledBrowser | null;
  ports: number[];
  listeners: LiveEpisode['listeners'];
}

async function provisionRole(o: {
  backend: EpisodeBackend;
  view: AgentEpisodeView;
  token: string;
  scratch: string;
  artifactsDir: string;
  pkiDir: string;
  browser: boolean;
  headed: boolean;
  label: string;
}): Promise<RoleEnv> {
  const { backend, view } = o;
  const base = {
    episodeId: view.episodeId,
    role: view.role,
    delegationId: view.delegationId,
    host: '127.0.0.1',
    port: 0,
  };
  const ports: number[] = [];
  const cli = await backend.addListener({ ...base, purpose: 'cli' });
  ports.push(cli.port);
  let browserListener: { port: number; url: string } | null = null;
  let browser: ControlledBrowser | null = null;
  const roleDir = path.join(o.scratch, o.label);
  const tokenFile = path.join(o.scratch, 'secrets', `${o.label}.token`);
  writeSecretFile(tokenFile, o.token);
  try {
    if (o.browser) {
      browserListener = await backend.addListener({ ...base, purpose: 'browser' });
      ports.push(browserListener.port);
      browser = await launchControlledBrowser({
        proxyPort: browserListener.port,
        proxyHost: backend.proxyHost,
        caDir: o.pkiDir,
        profileDir: path.join(roleDir, 'chromium-profile'),
        artifactsDir: o.artifactsDir,
        headless: !o.headed,
      });
    }
    const toolEnv = {
      [TOOL_ENV.agentApiUrl]: backend.agentApiUrl,
      [TOOL_ENV.tokenFile]: tokenFile,
    };
    const stdio = (name: 'bench' | 'browser', env: Record<string, string>): McpServerSpec => {
      const c = toolServerCommand(name);
      return { name, transport: { kind: 'stdio', command: c.command, args: c.args, env } };
    };
    const mcpServers: McpServerSpec[] = [stdio('bench', toolEnv)];
    if (browser)
      mcpServers.push(
        stdio('browser', {
          ...toolEnv,
          [TOOL_ENV.cdpEndpoint]: browser.cdpEndpoint,
          [TOOL_ENV.screenshotDir]: path.join(o.artifactsDir, 'screenshots'),
        }),
      );
    const workDir = path.join(roleDir, 'work');
    const configHome = path.join(roleDir, 'home');
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    mkdirSync(configHome, { recursive: true, mode: 0o700 });
    const tools: AgentTools = {
      episodeId: view.episodeId,
      role: view.role,
      mcpServers,
      proxyUrl: cli.url,
      caCertPath: path.join(o.pkiDir, 'ca.pem'),
      env: {
        HTTPS_PROXY: cli.url,
        HTTP_PROXY: cli.url,
        https_proxy: cli.url,
        http_proxy: cli.url,
        ALL_PROXY: cli.url,
        NO_PROXY: '',
        no_proxy: '',
        ...trustEnv(o.pkiDir),
      },
      workDir,
      configHome,
      cdpEndpoint: browser?.cdpEndpoint ?? null,
    };
    return { tools, browser, ports, listeners: { browser: browserListener, cli } };
  } catch (err) {
    await browser?.close().catch(() => undefined);
    for (const p of ports) await backend.removeListener(p).catch(() => undefined);
    throw err;
  }
}

function endReasonFor(r: AgentRunResult, stepsUsed: number, maxSteps: number): EndReason {
  if (stepsUsed > maxSteps) return 'max_steps';
  if (r.status === 'done') return 'final_response';
  if (r.status === 'timeout') return r.error === 'max_turns' ? 'max_steps' : 'timeout';
  return 'agent_error';
}

export async function runEpisode(opts: RunEpisodeOptions): Promise<EpisodeResult> {
  const p = opts.paths ?? benchPaths();
  const log = opts.log ?? (() => {});
  const seed = opts.seed ?? opts.spec.seed;
  const repetition = opts.repetition ?? 0;
  const runId = opts.runId ?? newRunId();
  const scratch = path.join(p.tmp, runId);
  const runDir = path.join(p.runs, runId);
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const startedAt = new Date().toISOString();
  const ownBackend = !opts.backend;
  const backend =
    opts.backend ??
    (await LocalBackend.start({
      ca: await ensureTrustMaterial(p.pki),
      runSecret: randomBytes(24).toString('hex'),
      presets: presetsFor(opts.agent),
      dataDir: path.join(scratch, 'world'),
      ...(opts.plugins ? { plugins: opts.plugins } : {}),
    }));
  const cleanups: (() => Promise<void>)[] = [];
  let parentAdapter: AgentAdapter | null = null;
  let delegations: DelegationManager | null = null;
  let liveEpisodeId: string | null = null;
  try {
    const episodeId = episodeIdFor(p, opts.spec, seed, repetition);
    const m = await backend.materialize({ spec: opts.spec, seed, runId, episodeId });
    const episode = m.episode;
    liveEpisodeId = episode.id;
    log(`episode ${episode.id} (${opts.spec.id}, seed ${seed}) → ${runDir}`);
    const artifacts = new RunArtifacts({
      root: p.runs,
      runId,
      agentReachablePaths: [scratch],
    });
    artifacts.writeEpisode(episode);

    const useBrowser = opts.browser !== false;
    const parentEnv = await provisionRole({
      backend,
      view: m.agentViews.parent,
      token: m.tokens.parent,
      scratch,
      artifactsDir: runDir,
      pkiDir: p.pki,
      browser: useBrowser,
      headed: opts.headed ?? false,
      label: 'parent',
    });
    cleanups.push(async () => {
      await parentEnv.browser?.close();
      for (const port of parentEnv.ports) await backend.removeListener(port).catch(() => undefined);
    });

    const observerFor = (role: string, delegationId: string | null): AgentObserver => ({
      onToolCall: (c) =>
        void backend
          .ingest(episode.id, {
            eventType: 'tool.call',
            role: role as 'parent',
            delegationId,
            payload: {
              toolCallId: c.toolCallId,
              server: c.server,
              tool: c.tool.slice(0, 128),
              args: JSON.parse(JSON.stringify(c.args ?? null)),
              outcome: c.outcome,
              error: c.error,
            },
          })
          .catch(() => undefined),
      onLog: (line) => log(`[${delegationId ?? role}] ${line}`),
    });

    const factory = ({
      role,
      delegationId,
    }: {
      role: 'parent' | 'funding_subagent';
      delegationId?: string | null;
    }) =>
      createAdapter(opts.agent, {
        role,
        transcriptPath: path.join(runDir, 'transcripts', `${delegationId ?? role}.jsonl`),
      });
    const host: DelegationHost = {
      onDelegationStarted: (cb) =>
        backend.onEvent(episode.id, (e) => {
          if (e.eventType === 'delegation.started')
            cb({
              delegationId: e.payload.delegationId,
              parentRole: e.payload.parentRole,
              childRole: e.payload.childRole,
              task: e.payload.task,
              grantedScope: e.payload.grantedScope,
            });
        }),
      childCredentials: (d) => backend.delegationToken(episode.id, d),
      childSteps: async (d) =>
        (await backend.state(episode.id)).attempts.filter((a) => a.delegationId === d).length,
      hasReport: async (d) =>
        ((await backend.state(episode.id)).delegations.find((x) => x.delegationId === d)?.reportIds
          .length ?? 0) > 0,
      submitRunnerReport: async (d, summary) => {
        await backend.runnerAction(episode.id, 'funding_subagent', d, 'submit_subagent_report', {
          delegationId: d,
          summary: summary.slice(0, 16000),
          claimIds: [],
          reportedResources: [],
        });
      },
      endDelegation: (d, status, fr) => backend.endDelegation(episode.id, d, status, fr),
      provision: async (d, token, view) => {
        const env = await provisionRole({
          backend,
          view,
          token,
          scratch,
          artifactsDir: path.join(runDir, 'children', d),
          pkiDir: p.pki,
          browser: useBrowser,
          headed: opts.headed ?? false,
          label: `child-${d}`,
        });
        return {
          tools: env.tools,
          release: async () => {
            await env.browser?.close();
            for (const port of env.ports) await backend.removeListener(port).catch(() => undefined);
          },
        };
      },
    };
    delegations = new DelegationManager(host, factory, opts.childLimits ?? {}, (d) =>
      observerFor('funding_subagent', d),
    );
    delegations.start();

    parentAdapter = factory({ role: 'parent' });
    const support = isFullyControlled(parentAdapter.capabilities) ? 'supported' : 'unsupported';
    if (support === 'unsupported')
      throw new Error(
        `agent ${parentAdapter.info.agentId} declares uncontrolled paths; refusing to run (spec §3)`,
      );
    await opts.onReady?.({
      backend,
      episode,
      runDir,
      tools: parentEnv.tools,
      browser: parentEnv.browser,
      listeners: parentEnv.listeners,
      scratch,
    });
    await parentAdapter.start(m.agentViews.parent, parentEnv.tools, observerFor('parent', null));

    const agentResult = await parentAdapter.runUntilDone();
    await parentAdapter.stop().catch(() => undefined);
    await delegations.stopAll();
    if (agentResult.finalResponse)
      await backend.ingest(episode.id, {
        eventType: 'agent.final_response',
        role: 'parent',
        delegationId: null,
        payload: { text: agentResult.finalResponse.slice(0, 64_000) },
      });
    const st = await backend.state(episode.id);
    const endReason = endReasonFor(agentResult, st.lifecycle.stepsUsed, episode.maxSteps);
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => undefined);
    await backend.endEpisode(episode.id, {
      reason: endReason,
      agentStatus: agentResult.status,
      error: agentResult.error,
    });
    log(
      `agent ${agentResult.status}${agentResult.error ? ` (${agentResult.error})` : ''}; episode ended: ${endReason}`,
    );

    const events = await backend.events(episode.id);
    const finalState = await backend.state(episode.id);
    const initialState = await backend.initialState(episode.id);
    const usage = agentResult.usage
      ? { ...agentResult.usage, worldActions: finalState.lifecycle.stepsUsed }
      : null;
    artifacts.writeEvents(events);
    artifacts.writeWorldFinal(finalState);
    artifacts.writeFile('world-initial.json', stableStringify(initialState), {
      parsed: initialState,
    });

    artifacts.setLive(false);
    const grade = gradeEpisode({
      episode,
      spec: { ...opts.spec, seed },
      expected: opts.expected,
      initialState,
      events,
      finalState,
      usage,
    });
    const info = parentAdapter.info;
    const meta: RunMetadata = {
      runId,
      episodeId: episode.id,
      scenarioId: opts.spec.id,
      agent: info,
      seed,
      fixtureVersion: opts.spec.fixtureVersion,
      envBuildHash: envBuildHash(p.root),
      graderVersion: GRADER_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      isolation: backend.isolation,
      repetition,
      suite: opts.suite ?? null,
      startedAt,
      endedAt: new Date().toISOString(),
      toolCost: usage,
      authMode: opts.agent.kind === 'scripted' ? 'none' : (opts.agent.auth ?? 'api_key'),
      endReason,
      support,
      environment: {
        node: process.version,
        platform: os.platform(),
        arch: os.arch(),
        chromium: parentEnv.browser?.context.browser()?.version() ?? null,
        gitCommit: gitCommit(p.root),
        nondeterministicFields: [
          'meta.json: runId, startedAt, endedAt, envBuildHash, toolCost',
          'episode.json: runId',
          'events.jsonl: episode.started.payload.runId',
          'grades.json: runId',
          'events.jsonl (browser runs): network.request/network.tunnel byte counts and relative order of network events',
        ],
      },
    };
    artifacts.writeMeta(meta);
    artifacts.writeGrades(grade.report);
    artifacts.writeReportHtml(
      renderRunReport({
        episode,
        meta,
        events,
        grades: grade.report,
        validationWarnings: grade.validationWarnings,
        screenshots: existsSync(path.join(runDir, 'screenshots'))
          ? readdirSync(path.join(runDir, 'screenshots')).sort()
          : [],
      }),
    );
    return { runId, runDir, episode, agentResult, endReason, grade, events, finalState, meta };
  } finally {
    await parentAdapter?.stop().catch(() => undefined);
    await delegations?.stopAll().catch(() => undefined);
    for (const c of cleanups.reverse()) await c().catch(() => undefined);
    if (liveEpisodeId) await backend.destroy(liveEpisodeId).catch(() => undefined);
    if (ownBackend) await backend.close().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  }
}
