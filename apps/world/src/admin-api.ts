import { timingSafeEqual, createHash } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Isolation, ScenarioSpec } from '@aab/protocol';
import { IngestError, type IngestDraft } from '@aab/world-state';
import { NotFoundError, type EpisodeHandle, type EpisodeRegistry } from './registry.js';

/** Resolves a scenario id to its WORLD view (no `expected`). */
export type ScenarioResolver = (scenarioId: string) => ScenarioSpec | null;

function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function describeHandle(h: EpisodeHandle) {
  return {
    episode: h.materialized.episode,
    tokens: h.materialized.tokens,
    agentViews: h.materialized.agentViews,
  };
}

/**
 * Admin API (runner/harness only). Bound to 127.0.0.1 on its own port with its own secret;
 * it is a separate Fastify instance, so none of these routes exist on the agent or site
 * listeners. Routes (all `Authorization: Bearer <adminSecret>`):
 *
 *   POST   /admin/episodes                       {scenarioId | spec, seed?, runId?, episodeId?, isolation?}
 *   GET    /admin/episodes
 *   GET    /admin/episodes/:id
 *   POST   /admin/episodes/:id/reset
 *   DELETE /admin/episodes/:id
 *   GET    /admin/episodes/:id/state             WorldState (live projection)
 *   GET    /admin/episodes/:id/initial-state     WorldState before any event
 *   GET    /admin/episodes/:id/events            events.jsonl
 *   POST   /admin/episodes/:id/events            ingest one draft or an array of drafts
 *   POST   /admin/episodes/:id/export            {dir} → events.jsonl, world-final.json, world-initial.json
 *   POST   /admin/episodes/:id/delegations/:dlg/token
 *   POST   /admin/episodes/:id/delegations/:dlg/end   {status, finalResponse?}
 *   POST   /admin/episodes/:id/actions/:action   {role, delegationId?, request} (via runner)
 *   POST   /admin/episodes/:id/end               {reason, agentStatus?, error?}
 */
export function buildAdminApi(
  registry: EpisodeRegistry,
  opts: { adminSecret: string; resolveScenario: ScenarioResolver | null },
): FastifyInstance {
  if (!opts.adminSecret || opts.adminSecret.length < 16)
    throw new Error('adminSecret must be at least 16 characters');
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  app.addHook('onRequest', async (req, reply) => {
    const h = req.headers.authorization;
    const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h.trim()) : null;
    if (!m || !sameSecret(m[1]!, opts.adminSecret))
      return reply.code(401).send({ error: 'unauthorized' });
  });

  const handle = (req: FastifyRequest) => registry.require((req.params as { id: string }).id);
  const body = (req: FastifyRequest) =>
    req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};

  app.post('/admin/episodes', async (req, reply) => {
    const b = body(req);
    let spec: ScenarioSpec | null = null;
    if (typeof b.scenarioId === 'string') {
      if (!opts.resolveScenario)
        return reply.code(400).send({ error: 'no scenarios directory configured' });
      spec = opts.resolveScenario(b.scenarioId);
      if (!spec) return reply.code(404).send({ error: `unknown scenario ${b.scenarioId}` });
    } else if (b.spec && typeof b.spec === 'object') {
      spec = b.spec as ScenarioSpec; // validated strictly (unknown keys such as `expected` rejected)
    } else return reply.code(400).send({ error: 'give scenarioId or spec' });
    const h = registry.materialize({
      spec,
      ...(typeof b.seed === 'number' ? { seed: b.seed } : {}),
      ...(typeof b.runId === 'string' ? { runId: b.runId } : {}),
      ...(typeof b.episodeId === 'string' ? { episodeId: b.episodeId } : {}),
      ...(typeof b.isolation === 'string' ? { isolation: b.isolation as Isolation } : {}),
    });
    return reply.code(201).send(describeHandle(h));
  });

  app.get('/admin/episodes', async () => ({ episodes: registry.ids() }));
  app.get('/admin/episodes/:id', async (req) => describeHandle(handle(req)));
  app.post('/admin/episodes/:id/reset', async (req) =>
    describeHandle(registry.reset(handle(req).materialized.episode.id)),
  );
  app.delete('/admin/episodes/:id', async (req, reply) => {
    registry.destroy(handle(req).materialized.episode.id);
    return reply.code(204).send();
  });
  app.get('/admin/episodes/:id/state', async (req) => handle(req).store.state());
  app.get('/admin/episodes/:id/initial-state', async (req) => handle(req).store.initialState());
  app.get('/admin/episodes/:id/events', async (req, reply) =>
    reply.type('application/x-ndjson').send(handle(req).store.exportEventsJsonl()),
  );
  app.post('/admin/episodes/:id/events', async (req) => {
    const store = handle(req).store;
    const drafts = Array.isArray(req.body)
      ? (req.body as IngestDraft[])
      : [req.body as IngestDraft];
    const events = drafts.map((d) => {
      const e = store.ingest(d);
      return e ? { seq: e.seq, eventId: e.eventId } : null;
    });
    return { events };
  });
  app.post('/admin/episodes/:id/export', async (req, reply) => {
    const dir = body(req).dir;
    if (typeof dir !== 'string' || !dir) return reply.code(400).send({ error: 'dir required' });
    return handle(req).store.writeArtifacts(dir);
  });
  app.post('/admin/episodes/:id/delegations/:dlg/token', async (req) =>
    registry.delegationToken(
      handle(req).materialized.episode.id,
      (req.params as { dlg: string }).dlg,
    ),
  );
  app.post('/admin/episodes/:id/delegations/:dlg/end', async (req) => {
    const b = body(req);
    const e = handle(req).store.endDelegation(
      (req.params as { dlg: string }).dlg,
      (b.status as 'completed') ?? 'completed',
      typeof b.finalResponse === 'string' ? b.finalResponse : null,
    );
    return { seq: e.seq, eventId: e.eventId };
  });
  // Runner-originated world operation (journaled with via `runner`, never judged as the agent's),
  // e.g. filing a child's final response as its subagent report.
  app.post('/admin/episodes/:id/actions/:action', async (req, reply) => {
    const b = body(req);
    const role = b.role === 'parent' || b.role === 'funding_subagent' ? b.role : null;
    if (!role) return reply.code(400).send({ error: 'role required' });
    return handle(req).store.execute(
      {
        role,
        delegationId: typeof b.delegationId === 'string' ? b.delegationId : null,
        via: 'runner',
      },
      (req.params as { action: string }).action,
      b.request ?? {},
    );
  });
  app.post('/admin/episodes/:id/end', async (req) => {
    const b = body(req);
    const e = handle(req).store.endEpisode({
      reason: (b.reason as 'final_response') ?? 'final_response',
      agentStatus: (b.agentStatus as 'done' | null | undefined) ?? null,
      error: typeof b.error === 'string' ? b.error : null,
    });
    return { seq: e.seq, eventId: e.eventId };
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));
  app.setErrorHandler((err, _req, reply: FastifyReply) => {
    if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
    if (err instanceof IngestError) return reply.code(400).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500)
      return reply.code(status).send({ error: (err as Error).message });
    return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
  });
  return app;
}
