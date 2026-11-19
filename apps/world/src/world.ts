import type { FastifyInstance } from 'fastify';
import type { ScenarioSpec } from '@aab/protocol';
import { listScenarioFiles, loadWorldScenario } from '@aab/scenarios';
import { buildAdminApi, type ScenarioResolver } from './admin-api.js';
import { buildAgentApi } from './agent-api.js';
import { probePlugin } from './probe.js';
import { EpisodeRegistry } from './registry.js';
import { buildSiteHost, type WorldSitePlugin } from './site-host.js';

export interface CreateWorldOptions {
  /** Secret the per-role agent tokens and opaque ids are derived from (>= 16 chars). */
  runSecret: string;
  /** Secret for the admin API (>= 16 chars). Must differ from runSecret. */
  adminSecret: string;
  /** Bind address of the agent API (and site host unless `siteHost`), default 127.0.0.1. */
  host?: string;
  /** 0 (default) = pick a free port. */
  agentApiPort?: number;
  sitePort?: number;
  adminPort?: number;
  /** Extra site plugins. `probe.eval.test` is always registered. */
  plugins?: readonly WorldSitePlugin[];
  /** Directory of scenario YAML so the admin API can materialise by `scenarioId`. */
  scenariosDir?: string | null;
  /** Per-episode SQLite files go here; null/undefined = in-memory. */
  dataDir?: string | null;
  /**
   * Shared secret the MITM proxy injects (TRUSTED_HEADERS.proxySecret). When set (>= 16 chars),
   * the site host refuses every request without it, so reaching the site-host port directly
   * cannot forge an identity. null = no check (only for tests that drive the site host directly).
   */
  proxySecret?: string | null;
  /** Bind address of the site host (default: `host`). */
  siteHost?: string;
  /**
   * Bind address of the admin API (default 127.0.0.1). In docker it is the harness-network IP,
   * reachable only by the runner's orchestration and protected by `adminSecret`.
   */
  adminHost?: string;
}

export interface WorldHandle {
  readonly host: string;
  readonly agentApiPort: number;
  readonly sitePort: number;
  readonly adminPort: number;
  /** In-process access for the runner (materialise, ingest, export without HTTP). */
  readonly registry: EpisodeRegistry;
  close(): Promise<void>;
}

/** Index scenario files by id, keeping ONLY world views (the answer key is dropped at load). */
export function scenarioResolverForDir(dir: string): ScenarioResolver {
  const byId = new Map<string, ScenarioSpec>();
  for (const f of listScenarioFiles(dir)) {
    const s = loadWorldScenario(f);
    if (byId.has(s.spec.id)) throw new Error(`duplicate scenario id ${s.spec.id} in ${f}`);
    byId.set(s.spec.id, s.spec);
  }
  return (id) => byId.get(id) ?? null;
}

async function listen(app: FastifyInstance, host: string, port: number): Promise<number> {
  await app.listen({ host, port });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('listener has no TCP address');
  return addr.port;
}

/** Start the world service: agent API, site host and admin API on three separate listeners. */
export async function createWorld(opts: CreateWorldOptions): Promise<WorldHandle> {
  if (opts.runSecret === opts.adminSecret)
    throw new Error('adminSecret must differ from runSecret');
  const proxySecret = opts.proxySecret ?? null;
  if (proxySecret !== null && proxySecret.length < 16)
    throw new Error('proxySecret must be at least 16 characters');
  if (proxySecret !== null && (proxySecret === opts.runSecret || proxySecret === opts.adminSecret))
    throw new Error('proxySecret must differ from runSecret and adminSecret');
  const plugins = [probePlugin, ...(opts.plugins ?? []).filter((p) => p.id !== probePlugin.id)];
  const registry = new EpisodeRegistry({
    runSecret: opts.runSecret,
    dataDir: opts.dataDir ?? null,
    knownHosts: plugins.flatMap((p) => p.hosts),
    proxySecret,
  });
  const host = opts.host ?? '127.0.0.1';
  const agentApi = buildAgentApi(registry);
  const siteHost = await buildSiteHost(registry, plugins);
  const adminApi = buildAdminApi(registry, {
    adminSecret: opts.adminSecret,
    resolveScenario: opts.scenariosDir ? scenarioResolverForDir(opts.scenariosDir) : null,
  });
  const apps = [agentApi, siteHost, adminApi];
  try {
    const agentApiPort = await listen(agentApi, host, opts.agentApiPort ?? 0);
    const sitePort = await listen(siteHost, opts.siteHost ?? host, opts.sitePort ?? 0);
    const adminPort = await listen(adminApi, opts.adminHost ?? '127.0.0.1', opts.adminPort ?? 0);
    let closed = false;
    return {
      host,
      agentApiPort,
      sitePort,
      adminPort,
      registry,
      async close() {
        if (closed) return;
        closed = true;
        await Promise.all(apps.map((a) => a.close()));
        registry.closeAll();
      },
    };
  } catch (err) {
    await Promise.all(apps.map((a) => a.close().catch(() => undefined)));
    registry.closeAll();
    throw err;
  }
}
