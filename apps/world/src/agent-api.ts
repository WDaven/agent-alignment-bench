import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ACTION_NAMES, IdSchema } from '@aab/protocol';
import type { EpisodeRegistry } from './registry.js';

/** Path of the Agent API route for an action: `POST /v1/actions/<action>`. */
export const agentActionPath = (action: string) => `/v1/actions/${action}`;
/** `GET` → AgentEpisodeView of the caller. */
export const AGENT_EPISODE_PATH = '/v1/episode';
/** Optional request headers the bench MCP server may send to enrich the journal. */
export const AGENT_HEADERS = { toolCallId: 'x-tool-call-id', pageUrl: 'x-page-url' } as const;

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h.trim());
  return m ? m[1]! : null;
}

function header(req: FastifyRequest, name: string): string | null {
  const v = req.headers[name];
  return typeof v === 'string' && v.length > 0 && v.length <= 2048 ? v : null;
}

/**
 * Agent API: one POST route per world operation, authenticated by a per-episode, per-role
 * (optionally per-delegation) bearer token. The body is accepted as raw text and journaled as
 * the attempt's request BEFORE any validation, so malformed JSON or schema violations are still
 * recorded attempts (denied `invalid_request`). Denials are HTTP 200 with `ok: false`.
 */
export function buildAgentApi(registry: EpisodeRegistry): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.get(AGENT_EPISODE_PATH, async (req, reply) => {
    const t = bearer(req);
    const id = t ? registry.authenticate(t) : null;
    if (!id) return reply.code(401).send({ error: 'unauthorized' });
    return registry.viewFor(id);
  });

  for (const action of ACTION_NAMES) {
    app.post(agentActionPath(action), async (req, reply) => {
      const t = bearer(req);
      const id = t ? registry.authenticate(t) : null;
      if (!id) return reply.code(401).send({ error: 'unauthorized' });
      const text = typeof req.body === 'string' ? req.body : '';
      let raw: unknown;
      if (text.trim() === '') raw = {};
      else {
        try {
          raw = JSON.parse(text);
        } catch {
          raw = text; // journaled as-is; the schema check then denies it as invalid_request
        }
      }
      return id.handle.store.execute(
        {
          role: id.role,
          delegationId: id.delegationId,
          via: 'bench_tool',
          toolCallId: IdSchema.safeParse(header(req, AGENT_HEADERS.toolCallId)).data ?? null,
          pageUrl: header(req, AGENT_HEADERS.pageUrl),
        },
        action,
        raw,
      );
    });
  }

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    reply
      .code(status && status >= 400 && status < 500 ? status : 500)
      .send({ error: 'request failed' });
  });
  return app;
}
