import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  AgentEpisodeViewSchema,
  ScenarioSpecSchema,
  type AgentEpisodeView,
  type AgentRole,
  type Isolation,
  type ScenarioSpec,
} from '@aab/protocol';
import { deriveRoleToken, materialize, type MaterializedEpisode } from '@aab/scenarios';
import { WorldStore } from '@aab/world-state';

export interface MaterializeRequest {
  /** World view of a scenario. Validated strictly: an `expected` key is rejected. */
  spec: ScenarioSpec;
  seed?: number;
  runId?: string;
  episodeId?: string;
  isolation?: Isolation;
}

export interface EpisodeHandle {
  readonly materialized: MaterializedEpisode;
  readonly store: WorldStore;
  readonly request: Readonly<MaterializeRequest>;
}

export interface Identity {
  episodeId: string;
  role: AgentRole;
  delegationId: string | null;
}

/**
 * All live episodes of this world process, plus the bearer-token index. The registry only ever
 * receives `ScenarioSpec`s (the world view); it has no field or parameter for `expected`.
 */
export class EpisodeRegistry {
  private readonly episodes = new Map<string, EpisodeHandle>();
  private readonly tokens = new Map<string, Identity>();

  constructor(
    private readonly opts: {
      runSecret: string;
      /** Directory for per-episode SQLite files; null = in-memory databases. */
      dataDir: string | null;
      /** Hosts served by registered site plugins (browse reports them as existing). */
      knownHosts: readonly string[];
      /** Shared secret the proxy sends in TRUSTED_HEADERS.proxySecret; null = not required. */
      proxySecret?: string | null;
    },
  ) {
    if (!opts.runSecret || opts.runSecret.length < 16)
      throw new Error('runSecret must be at least 16 characters');
  }

  /** Secret required on site-host requests (TRUSTED_HEADERS.proxySecret), or null. */
  get proxySecret(): string | null {
    return this.opts.proxySecret ?? null;
  }

  private dbPath(episodeId: string): string | undefined {
    return this.opts.dataDir ? path.join(this.opts.dataDir, `${episodeId}.sqlite`) : undefined;
  }

  materialize(req: MaterializeRequest): EpisodeHandle {
    const spec = ScenarioSpecSchema.parse(req.spec);
    const m = materialize(spec, req.seed ?? spec.seed, {
      runSecret: this.opts.runSecret,
      ...(req.runId ? { runId: req.runId } : {}),
      ...(req.episodeId ? { episodeId: req.episodeId } : {}),
    });
    if (this.episodes.has(m.episode.id)) throw new Error(`episode ${m.episode.id} already exists`);
    const file = this.dbPath(m.episode.id);
    if (file && existsSync(file)) rmSync(file);
    const store = WorldStore.create({
      spec: m.spec,
      episode: m.episode,
      isolation: req.isolation ?? 'proxy-only',
      knownHosts: this.opts.knownHosts,
      ...(file ? { dbPath: file } : {}),
    });
    const handle: EpisodeHandle = { materialized: m, store, request: { ...req, spec } };
    this.episodes.set(m.episode.id, handle);
    for (const role of Object.keys(m.tokens) as AgentRole[])
      this.tokens.set(m.tokens[role], { episodeId: m.episode.id, role, delegationId: null });
    return handle;
  }

  get(episodeId: string): EpisodeHandle | undefined {
    return this.episodes.get(episodeId);
  }

  require(episodeId: string): EpisodeHandle {
    const h = this.episodes.get(episodeId);
    if (!h) throw new NotFoundError(`no episode ${episodeId}`);
    return h;
  }

  ids(): string[] {
    return [...this.episodes.keys()].sort();
  }

  /** Destroy the database and re-materialise with the same spec, seed and ids. */
  reset(episodeId: string): EpisodeHandle {
    const h = this.require(episodeId);
    this.destroy(episodeId);
    return this.materialize({
      ...h.request,
      episodeId: h.materialized.episode.id,
      runId: h.materialized.episode.runId,
    });
  }

  destroy(episodeId: string): void {
    const h = this.require(episodeId);
    h.store.close();
    const file = this.dbPath(episodeId);
    if (file)
      for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
    this.episodes.delete(episodeId);
    for (const [t, id] of this.tokens) if (id.episodeId === episodeId) this.tokens.delete(t);
  }

  /** Token for a child agent bound to one delegation (role = the delegation's child role). */
  delegationToken(
    episodeId: string,
    delegationId: string,
  ): { token: string; view: AgentEpisodeView } {
    const h = this.require(episodeId);
    const d = h.store.state().delegations.find((x) => x.delegationId === delegationId);
    if (!d) throw new NotFoundError(`no delegation ${delegationId}`);
    const token = deriveRoleToken(this.opts.runSecret, episodeId, d.childRole, delegationId);
    this.tokens.set(token, { episodeId, role: d.childRole, delegationId });
    return { token, view: this.viewFor({ episodeId, role: d.childRole, delegationId })! };
  }

  authenticate(token: string): (Identity & { handle: EpisodeHandle }) | null {
    const id = this.tokens.get(token);
    if (!id) return null;
    const handle = this.episodes.get(id.episodeId);
    return handle ? { ...id, handle } : null;
  }

  /** What an agent is told about itself. Never includes seed, variant, scenario id or expected values. */
  viewFor(id: Identity): AgentEpisodeView | null {
    const h = this.episodes.get(id.episodeId);
    if (!h) return null;
    const base = h.materialized.agentViews[id.role];
    if (!id.delegationId) return base;
    const d = h.store.state().delegations.find((x) => x.delegationId === id.delegationId);
    if (!d) return null;
    return AgentEpisodeViewSchema.parse({
      ...base,
      task: d.task,
      delegationId: d.delegationId,
      availableActions: d.grantedScope,
    });
  }

  closeAll(): void {
    for (const id of this.ids()) {
      const h = this.episodes.get(id)!;
      h.store.close();
    }
    this.episodes.clear();
    this.tokens.clear();
  }
}

export class NotFoundError extends Error {
  override name = 'NotFoundError';
}
