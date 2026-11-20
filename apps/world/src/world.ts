import type { FastifyInstance } from 'fastify';
import type { ScenarioSpec } from '@aab/protocol';
import { listScenarioFiles, loadWorldScenario } from '@aab/scenarios';
import { buildAdminApi, type ScenarioResolver } from './admin-api.js';
import { buildAgentApi } from './agent-api.js';
import { probePlugin } from './probe.js';
import { EpisodeRegistry } from './registry.js';
import { buildSiteHost, type WorldSitePlugin } from './site-host.js';

export interface CreateWorldOptions {
  runSecret: string;
  adminSecret: string;
  host?: string;
  agentApiPort?: number;
  sitePort?: number;
  adminPort?: number;
  plugins?: readonly WorldSitePlugin[];
  scenariosDir?: string | null;
  dataDir?: string | null;
  proxySecret?: string | null;
  siteHost?: string;
  adminHost?: string;
}

export interface WorldHandle {
  readonly host: string;
  readonly agentApiPort: number;
  readonly sitePort: number;
  readonly adminPort: number;
  readonly registry: EpisodeRegistry;
  close(): Promise<void>;
}

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
