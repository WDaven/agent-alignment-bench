/**
 * Where the world service and the MITM proxy live for a run.
 *
 * - `LocalBackend` (default, `isolation: proxy-only`): `bench run` self-hosts a fresh world
 *   (agent API, site host, admin API) and proxy IN THIS PROCESS for every episode and tears them
 *   down afterwards. No daemon, no shared state between runs.
 * - `RemoteBackend` (compose mode, `isolation: container`): the world and proxy run in their own
 *   containers; the runner drives them through the world admin API and the proxy control
 *   endpoint, and relays proxy network events into the world journal.
 */
import { randomBytes } from 'node:crypto';
import {
  RunEventSchema,
  type AgentEpisodeView,
  type AgentRole,
  type Episode,
  type Isolation,
  type ProxyListenerInput,
  type RunEvent,
  type ScenarioSpec,
  type WorldState,
} from '@aab/protocol';
import type { EvalCa } from '@aab/pki';
import {
  MitmProxy,
  ProxyControlClient,
  buildProxyPolicy,
  type PassthroughPresetName,
} from '@aab/mitm-proxy';
import { createWorld, type WorldHandle, type WorldSitePlugin } from '@aab/world';
import type { IngestDraft } from '@aab/world-state';

export interface MaterializedView {
  episode: Episode;
  tokens: Record<AgentRole, string>;
  agentViews: Record<AgentRole, AgentEpisodeView>;
}

export type EndReason =
  'final_response' | 'max_steps' | 'timeout' | 'agent_error' | 'harness_error' | 'aborted';

export interface EpisodeBackend {
  readonly kind: 'local' | 'remote';
  readonly isolation: Isolation;
  /** Base URL of the world Agent API as seen by the agent's MCP servers. */
  readonly agentApiUrl: string;
  /** Host the browser / CLI use to reach their proxy listeners. */
  readonly proxyHost: string;
  materialize(req: {
    spec: ScenarioSpec;
    seed: number;
    runId: string;
    episodeId: string;
  }): Promise<MaterializedView>;
  addListener(spec: ProxyListenerInput): Promise<{ port: number; url: string }>;
  removeListener(port: number): Promise<void>;
  events(episodeId: string): Promise<RunEvent[]>;
  state(episodeId: string): Promise<WorldState>;
  initialState(episodeId: string): Promise<WorldState>;
  ingest(episodeId: string, draft: IngestDraft): Promise<void>;
  runnerAction(
    episodeId: string,
    role: AgentRole,
    delegationId: string | null,
    action: string,
    request: unknown,
  ): Promise<unknown>;
  delegationToken(
    episodeId: string,
    delegationId: string,
  ): Promise<{ token: string; view: AgentEpisodeView }>;
  endDelegation(
    episodeId: string,
    delegationId: string,
    status: 'completed' | 'timeout' | 'error' | 'cancelled',
    finalResponse: string | null,
  ): Promise<void>;
  endEpisode(
    episodeId: string,
    p: {
      reason: EndReason;
      agentStatus: 'done' | 'timeout' | 'error' | null;
      error: string | null;
    },
  ): Promise<void>;
  /** Subscribe to new journal events (local: synchronous; remote: polled). */
  onEvent(episodeId: string, cb: (e: RunEvent) => void): () => void;
  /** Destroy the episode database (reset). */
  destroy(episodeId: string): Promise<void>;
  close(): Promise<void>;
}

const secret = () => randomBytes(24).toString('base64url');

// ---------------------------------------------------------------------------
// local
// ---------------------------------------------------------------------------

export class LocalBackend implements EpisodeBackend {
  readonly kind = 'local' as const;
  readonly isolation = 'proxy-only' as const;
  readonly proxyHost = '127.0.0.1';
  private constructor(
    private readonly world: WorldHandle,
    private readonly proxy: MitmProxy,
  ) {}

  /**
   * Start world + proxy. `runSecret` derives the per-role tokens; admin and proxy secrets are
   * random per backend. `presets` = model-API passthrough for the CLI listener only.
   */
  static async start(opts: {
    ca: EvalCa;
    runSecret: string;
    presets: readonly PassthroughPresetName[];
    dataDir: string | null;
    /** Extra site plugins (probe.eval.test is always there). No simulated sites ship yet. */
    plugins?: readonly WorldSitePlugin[];
  }): Promise<LocalBackend> {
    const proxySecret = secret();
    const world = await createWorld({
      runSecret: opts.runSecret,
      adminSecret: secret(),
      proxySecret,
      dataDir: opts.dataDir,
      scenariosDir: null,
      ...(opts.plugins ? { plugins: opts.plugins } : {}),
    });
    const proxy = new MitmProxy({
      ca: opts.ca,
      policy: buildProxyPolicy({ presets: opts.presets }),
      upstream: { host: '127.0.0.1', port: world.sitePort },
      upstreamSecret: proxySecret,
      // The agent API is for the MCP servers (direct loopback), never a proxy target; admin neither.
      internalEndpoints: [
        { host: '127.0.0.1', port: world.agentApiPort },
        { host: '127.0.0.1', port: world.adminPort },
      ],
      sink: (event, ctx) => {
        const h = world.registry.get(ctx.episodeId);
        if (!h || !h.store.episodeActive) return;
        try {
          h.store.ingest(event as IngestDraft);
        } catch {
          /* malformed network event: dropped (proxy bug, not agent behaviour) */
        }
      },
      onError: () => {},
    });
    return new LocalBackend(world, proxy);
  }

  get agentApiUrl(): string {
    return `http://127.0.0.1:${this.world.agentApiPort}`;
  }

  /** Ports of the in-process services (leakage tests). */
  get ports() {
    return {
      agentApi: this.world.agentApiPort,
      site: this.world.sitePort,
      admin: this.world.adminPort,
    };
  }

  private store(episodeId: string) {
    return this.world.registry.require(episodeId).store;
  }

  async materialize(req: { spec: ScenarioSpec; seed: number; runId: string; episodeId: string }) {
    const h = this.world.registry.materialize({ ...req, isolation: this.isolation });
    const m = h.materialized;
    return {
      episode: m.episode,
      tokens: { ...m.tokens },
      agentViews: { ...m.agentViews },
    };
  }
  async addListener(spec: ProxyListenerInput) {
    const b = await this.proxy.addListener(spec);
    return { port: b.port, url: b.url };
  }
  async removeListener(port: number) {
    await this.proxy.removeListener(port);
  }
  async events(episodeId: string) {
    return this.store(episodeId).events();
  }
  async state(episodeId: string) {
    return this.store(episodeId).state();
  }
  async initialState(episodeId: string) {
    return this.store(episodeId).initialState();
  }
  async ingest(episodeId: string, draft: IngestDraft) {
    const s = this.store(episodeId);
    if (s.episodeActive) s.ingest(draft);
  }
  async runnerAction(
    episodeId: string,
    role: AgentRole,
    delegationId: string | null,
    action: string,
    request: unknown,
  ) {
    return this.store(episodeId).execute({ role, delegationId, via: 'runner' }, action, request);
  }
  async delegationToken(episodeId: string, delegationId: string) {
    return this.world.registry.delegationToken(episodeId, delegationId);
  }
  async endDelegation(
    episodeId: string,
    delegationId: string,
    status: 'completed' | 'timeout' | 'error' | 'cancelled',
    finalResponse: string | null,
  ) {
    this.store(episodeId).endDelegation(delegationId, status, finalResponse);
  }
  async endEpisode(
    episodeId: string,
    p: {
      reason: EndReason;
      agentStatus: 'done' | 'timeout' | 'error' | null;
      error: string | null;
    },
  ) {
    const s = this.store(episodeId);
    if (s.episodeActive) s.endEpisode(p);
  }
  onEvent(episodeId: string, cb: (e: RunEvent) => void) {
    return this.store(episodeId).onEvent(cb);
  }
  async destroy(episodeId: string) {
    if (this.world.registry.get(episodeId)) this.world.registry.destroy(episodeId);
  }
  async close() {
    await this.proxy.close();
    await this.world.close();
  }
}

// ---------------------------------------------------------------------------
// remote (docker compose)
// ---------------------------------------------------------------------------

export interface RemoteBackendOptions {
  /** World admin API base URL, e.g. http://172.29.0.3:7820 (harness network only). */
  adminUrl: string;
  adminSecret: string;
  /** World agent API as the runner container reaches it, e.g. http://172.30.0.3:7800. */
  agentApiUrl: string;
  /** Proxy control endpoint, e.g. http://172.29.0.2:8090. */
  proxyControlUrl: string;
  proxyControlToken: string;
  /** Address the runner container uses for proxy listeners, e.g. 172.30.0.2. */
  proxyHost: string;
  /** Bind address for new listeners inside the proxy container (default: proxyHost). */
  listenerBindHost?: string;
}

export class RemoteBackend implements EpisodeBackend {
  readonly kind = 'remote' as const;
  readonly isolation = 'container' as const;
  readonly agentApiUrl: string;
  readonly proxyHost: string;
  private readonly control: ProxyControlClient;
  private relayAfter = 0;
  private relayTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly o: RemoteBackendOptions) {
    this.agentApiUrl = o.agentApiUrl;
    this.proxyHost = o.proxyHost;
    this.control = new ProxyControlClient(o.proxyControlUrl, o.proxyControlToken);
  }

  private async admin<T>(method: string, path: string, body?: unknown, text = false): Promise<T> {
    const r = await fetch(`${this.o.adminUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.o.adminSecret}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (r.status >= 300)
      throw new Error(`world admin ${method} ${path}: ${r.status} ${await r.text()}`);
    if (r.status === 204) return undefined as T;
    return (text ? await r.text() : await r.json()) as T;
  }

  async materialize(req: { spec: ScenarioSpec; seed: number; runId: string; episodeId: string }) {
    await this.control.health();
    const m = await this.admin<MaterializedView>('POST', '/admin/episodes', {
      spec: req.spec,
      seed: req.seed,
      runId: req.runId,
      episodeId: req.episodeId,
      isolation: this.isolation,
    });
    this.startRelay();
    return m;
  }

  /** Relay proxy network events into the world journal (the proxy has no world access). */
  private startRelay() {
    if (this.relayTimer || this.closed) return;
    const tick = async () => {
      if (this.closed) return;
      try {
        const r = await this.control.events(this.relayAfter);
        for (const e of r.events) {
          await this.admin('POST', `/admin/episodes/${e.episodeId}/events`, e.event).catch(
            () => undefined,
          );
          this.relayAfter = e.n;
        }
      } catch {
        /* retry next tick */
      }
      if (!this.closed) this.relayTimer = setTimeout(() => void tick(), 200);
    };
    this.relayTimer = setTimeout(() => void tick(), 200);
  }

  /** Flush pending network events (called before export). */
  async flushRelay(): Promise<void> {
    for (let i = 0; i < 5; i++) {
      const r = await this.control.events(this.relayAfter);
      if (r.events.length === 0) return;
      for (const e of r.events) {
        await this.admin('POST', `/admin/episodes/${e.episodeId}/events`, e.event).catch(
          () => undefined,
        );
        this.relayAfter = e.n;
      }
    }
  }

  async addListener(spec: ProxyListenerInput) {
    // Bind on the agent-network address only (not the harness or world networks).
    const b = await this.control.addListener({
      ...spec,
      host: this.o.listenerBindHost ?? this.proxyHost,
    });
    return { port: b.port, url: `http://${this.proxyHost}:${b.port}` };
  }
  async removeListener(port: number) {
    await this.control.removeListener(port);
  }
  async events(episodeId: string) {
    await this.flushRelay().catch(() => undefined);
    const text = await this.admin<string>(
      'GET',
      `/admin/episodes/${episodeId}/events`,
      undefined,
      true,
    );
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => RunEventSchema.parse(JSON.parse(l)));
  }
  state(episodeId: string) {
    return this.admin<WorldState>('GET', `/admin/episodes/${episodeId}/state`);
  }
  initialState(episodeId: string) {
    return this.admin<WorldState>('GET', `/admin/episodes/${episodeId}/initial-state`);
  }
  async ingest(episodeId: string, draft: IngestDraft) {
    await this.admin('POST', `/admin/episodes/${episodeId}/events`, draft);
  }
  runnerAction(
    episodeId: string,
    role: AgentRole,
    delegationId: string | null,
    action: string,
    request: unknown,
  ) {
    return this.admin('POST', `/admin/episodes/${episodeId}/actions/${action}`, {
      role,
      delegationId,
      request,
    });
  }
  delegationToken(episodeId: string, delegationId: string) {
    return this.admin<{ token: string; view: AgentEpisodeView }>(
      'POST',
      `/admin/episodes/${episodeId}/delegations/${delegationId}/token`,
      {},
    );
  }
  async endDelegation(
    episodeId: string,
    delegationId: string,
    status: string,
    finalResponse: string | null,
  ) {
    await this.admin('POST', `/admin/episodes/${episodeId}/delegations/${delegationId}/end`, {
      status,
      finalResponse,
    });
  }
  async endEpisode(
    episodeId: string,
    p: { reason: EndReason; agentStatus: string | null; error: string | null },
  ) {
    await this.flushRelay().catch(() => undefined);
    await this.admin('POST', `/admin/episodes/${episodeId}/end`, p);
  }
  onEvent(episodeId: string, cb: (e: RunEvent) => void) {
    let seen = 0;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const evs = await this.events(episodeId);
        for (const e of evs.slice(seen)) cb(e);
        seen = evs.length;
      } catch {
        /* retry */
      }
      if (!stop) setTimeout(() => void tick(), 300);
    };
    void tick();
    return () => {
      stop = true;
    };
  }
  async destroy(episodeId: string) {
    await this.admin('DELETE', `/admin/episodes/${episodeId}`).catch(() => undefined);
  }
  async close() {
    this.closed = true;
    if (this.relayTimer) clearTimeout(this.relayTimer);
    this.relayTimer = null;
  }
}
