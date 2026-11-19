import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  AGENT_ROLES,
  HostSchema,
  TRUSTED_HEADERS,
  type ActionName,
  type ActionRequestInput,
  type AgentRole,
  type MaterializedFixture,
  type SiteContext,
  type SitePlugin,
  type SiteRequestInfo,
  type SiteRequestScope,
  type TrapExposureRecorder,
  type WorldOpCallContext,
  type WorldOpResponse,
  type WorldOpsClient,
} from '@aab/protocol';
import { siteSeedFor } from '@aab/scenarios';
import type { EpisodeRegistry } from './registry.js';

/** Site plugins are written against a Fastify instance. */
export type WorldSitePlugin = SitePlugin<FastifyInstance>;

export class SiteIdentityError extends Error {
  override name = 'SiteIdentityError';
}

function one(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v.length === 1 ? v[0]! : null;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Lower-cased host from a Host header, without port. Null if it is not a valid DNS host. */
export function hostOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  return HostSchema.safeParse(h).success ? h : null;
}

function hostRegex(hosts: readonly string[]): RegExp {
  const alt = hosts.map((h) => h.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`^(?:${alt})(?::\\d+)?$`, 'i');
}

/** Role-bound world-ops client handed to site plugins (`via: 'site'`). */
export function siteOpsClient(
  registry: EpisodeRegistry,
  episodeId: string,
  role: AgentRole,
  delegationId: string | null,
): WorldOpsClient {
  return {
    episodeId,
    role,
    delegationId,
    async call<A extends ActionName>(
      action: A,
      request: ActionRequestInput<A>,
      ctx?: WorldOpCallContext,
    ): Promise<WorldOpResponse<A>> {
      const h = registry.require(episodeId);
      return h.store.execute(
        {
          role,
          delegationId,
          via: 'site',
          toolCallId: ctx?.toolCallId ?? null,
          pageUrl: ctx?.pageUrl ?? null,
        },
        action,
        request,
      ) as WorldOpResponse<A>;
    },
  };
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

/**
 * Resolve identity ONLY from the proxy's trusted headers. Throws SiteIdentityError if they are
 * missing, malformed, or name no live episode / delegation, or (when the site host was given a
 * proxy secret) if the request does not carry it — i.e. it did not come through the proxy.
 */
export function resolveIdentity(
  registry: EpisodeRegistry,
  headers: SiteRequestInfo['headers'],
  proxySecret: string | null = registry.proxySecret,
): { episodeId: string; role: AgentRole; delegationId: string | null } {
  if (proxySecret !== null) {
    const got = one(headers[TRUSTED_HEADERS.proxySecret]);
    if (!got || !sameSecret(got, proxySecret))
      throw new SiteIdentityError('request did not come through the bench proxy');
  }
  const episodeId = one(headers[TRUSTED_HEADERS.episode]);
  const role = one(headers[TRUSTED_HEADERS.role]);
  const delegationId = one(headers[TRUSTED_HEADERS.delegation]);
  if (!episodeId || !role) throw new SiteIdentityError('missing trusted bench identity headers');
  if (!(AGENT_ROLES as readonly string[]).includes(role))
    throw new SiteIdentityError('bad role header');
  const h = registry.get(episodeId);
  if (!h) throw new SiteIdentityError('unknown episode');
  if (delegationId) {
    const d = h.store.state().delegations.find((x) => x.delegationId === delegationId);
    if (!d || d.childRole !== role) throw new SiteIdentityError('unknown delegation');
  }
  return { episodeId, role: role as AgentRole, delegationId };
}

interface RequestMeta {
  title: string | null;
  siteId: string | null;
  notFound: boolean;
}

/**
 * Site host: the listener the MITM proxy forwards `*.eval.test` to. Every request must carry
 * the trusted x-bench-* identity (otherwise 403, nothing journaled); requests are dispatched by
 * `Host` to registered plugins (each plugin's routes are constrained to its hosts); unknown
 * hosts get a 404 page. Every identified request is journaled as `page.navigated`.
 */
export async function buildSiteHost(
  registry: EpisodeRegistry,
  plugins: readonly WorldSitePlugin[],
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
  const meta = new WeakMap<FastifyRequest, RequestMeta>();
  const hostOwner = new Map<string, string>();
  for (const p of plugins) {
    for (const h of p.hosts) {
      const prev = hostOwner.get(h);
      if (prev) throw new Error(`host ${h} claimed by both ${prev} and ${p.id}`);
      hostOwner.set(h, p.id);
    }
  }

  app.addHook('onRequest', async (req, reply) => {
    meta.set(req, { title: null, siteId: null, notFound: false });
    try {
      resolveIdentity(registry, req.headers);
    } catch (err) {
      return reply
        .code(403)
        .type('text/plain; charset=utf-8')
        .send(`forbidden: ${err instanceof SiteIdentityError ? err.message : 'bad request'}\n`);
    }
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const m = meta.get(req);
    if (
      m &&
      typeof payload === 'string' &&
      /html/i.test(String(reply.getHeader('content-type') ?? ''))
    ) {
      const t = /<title>([^<]{0,300})<\/title>/i.exec(payload);
      m.title = t ? t[1]!.trim() : null;
    }
    return payload;
  });

  app.addHook('onResponse', async (req, reply) => {
    let id;
    try {
      id = resolveIdentity(registry, req.headers);
    } catch {
      return; // unidentified requests were refused and are not journaled
    }
    const host = hostOf(req.headers.host);
    if (!host) return;
    const m = meta.get(req);
    const h = registry.get(id.episodeId);
    if (!h || !h.store.episodeActive) return;
    h.store.ingest({
      eventType: 'page.navigated',
      role: id.role,
      delegationId: id.delegationId,
      pageUrl: `https://${host}${req.url}`,
      payload: {
        url: `https://${host}${req.url}`,
        host,
        method: req.method,
        status: reply.statusCode,
        title: m?.title ?? null,
        siteId: m?.notFound ? null : (hostOwner.get(host) ?? null),
      },
    });
  });

  for (const plugin of plugins) {
    const ctx: SiteContext = {
      resolve(req: SiteRequestInfo): SiteRequestScope {
        const id = resolveIdentity(registry, req.headers);
        const h = registry.require(id.episodeId);
        const m = h.materialized;
        const fixture: MaterializedFixture = {
          episodeId: m.fixture.episodeId,
          scenarioId: m.fixture.scenarioId,
          seed: m.fixture.seed,
          world: m.fixture.world,
          traps: m.fixture.traps.filter((t) => t.host === null || plugin.hosts.includes(t.host)),
          userTask: m.fixture.userTask,
        };
        const traps: TrapExposureRecorder = {
          async recordExposure(trapId, details) {
            registry
              .require(id.episodeId)
              .store.recordTrapExposure(
                { role: id.role, delegationId: id.delegationId },
                trapId,
                details,
              );
          },
        };
        return {
          episodeId: id.episodeId,
          role: id.role,
          delegationId: id.delegationId,
          ops: siteOpsClient(registry, id.episodeId, id.role, id.delegationId),
          fixture,
          traps,
        };
      },
      seedFor(episodeId: string): number {
        return siteSeedFor(registry.require(episodeId).materialized.spec.seed, plugin.id);
      },
    };
    const constraint = hostRegex(plugin.hosts);
    await app.register(async (child) => {
      // Scope every route of this plugin to its own hosts.
      child.addHook('onRoute', (route) => {
        route.constraints = { ...(route.constraints ?? {}), host: constraint };
      });
      await plugin.register(child, ctx);
    });
  }

  app.setNotFoundHandler((req, reply) => {
    const m = meta.get(req);
    if (m) m.notFound = true;
    const host = hostOf(req.headers.host) ?? 'unknown host';
    return reply
      .code(404)
      .type('text/html; charset=utf-8')
      .send(
        `<!doctype html><html><head><title>Not found</title></head><body><h1>404 - Not found</h1><p>No page at ${escapeHtml(host)}${escapeHtml(req.url)}.</p></body></html>`,
      );
  });
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    reply
      .code(status && status >= 400 && status < 500 ? status : 500)
      .type('text/plain; charset=utf-8')
      .send('request failed\n');
  });
  return app;
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
