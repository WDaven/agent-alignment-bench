import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ACTION_NAMES, IdSchema, JsonValueSchema } from '@aab/protocol';
import { z } from 'zod';
import type { EpisodeRegistry } from './registry.js';

/** Path of the Agent API route for an action: `POST /v1/actions/<action>`. */
export const agentActionPath = (action: string) => `/v1/actions/${action}`;
/** `GET` → AgentEpisodeView of the caller. */
export const AGENT_EPISODE_PATH = '/v1/episode';
/** Optional request headers the bench MCP server may send to enrich the journal. */
export const AGENT_HEADERS = { toolCallId: 'x-tool-call-id', pageUrl: 'x-page-url' } as const;
/** `POST` a tool.call record (the MCP servers journal every tool call they serve). */
export const AGENT_TOOL_CALL_PATH = '/v1/tool-calls';
/** `GET` (parent token) → status and reports of one of the caller's delegations. */
export const agentDelegationPath = (delegationId: string) => `/v1/delegations/${delegationId}`;

/**
 * Body of `POST /v1/tool-calls`. Role / delegation / episode come from the bearer token, never
 * from the body. Informational only: graders do not use tool.call events for policy decisions.
 */
export const ToolCallReportSchema = z.strictObject({
  toolCallId: IdSchema,
  server: z.enum(['browser', 'bench']),
  tool: z.string().min(1).max(128),
  args: JsonValueSchema,
  outcome: z.enum(['ok', 'error']),
  error: z.string().max(4000).nullable(),
  pageUrl: z.string().max(2048).nullable().default(null),
});
export type ToolCallReport = z.input<typeof ToolCallReportSchema>;

/** Response of `GET /v1/delegations/:id`. Reports are UNTRUSTED claims by the child. */
export interface DelegationStatusView {
  delegationId: string;
  status: 'active' | 'completed' | 'timeout' | 'error' | 'cancelled';
  finalResponse: string | null;
  reports: {
    reportId: string;
    summary: string;
    claimIds: string[];
    reportedResources: unknown[];
  }[];
}

function parseBody(text: string): unknown {
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return text; // journaled as-is; the schema check then denies it as invalid_request
  }
}

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
      const raw = parseBody(typeof req.body === 'string' ? req.body : '');
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

  // Unknown operation names are journaled (action.unknown) rather than silently 404'd: an agent
  // calling a non-existent action is behaviour worth recording. Returned as a normal denial.
  app.post('/v1/actions/:name', async (req, reply) => {
    const t = bearer(req);
    const id = t ? registry.authenticate(t) : null;
    if (!id) return reply.code(401).send({ error: 'unauthorized' });
    if (!id.handle.store.episodeActive)
      return {
        ok: false,
        action: (req.params as { name: string }).name.slice(0, 128),
        attemptId: null,
        denial: { reason: 'episode_not_active', message: 'the episode has ended' },
      };
    return id.handle.store.executeUnknown(
      {
        role: id.role,
        delegationId: id.delegationId,
        via: 'bench_tool',
        toolCallId: IdSchema.safeParse(header(req, AGENT_HEADERS.toolCallId)).data ?? null,
        pageUrl: header(req, AGENT_HEADERS.pageUrl),
      },
      (req.params as { name: string }).name,
      parseBody(typeof req.body === 'string' ? req.body : ''),
    );
  });

  app.post(AGENT_TOOL_CALL_PATH, async (req, reply) => {
    const t = bearer(req);
    const id = t ? registry.authenticate(t) : null;
    if (!id) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = ToolCallReportSchema.safeParse(
      parseBody(typeof req.body === 'string' ? req.body : ''),
    );
    if (!parsed.success) return reply.code(400).send({ error: 'invalid tool call record' });
    const store = id.handle.store;
    if (!store.episodeActive) return reply.code(409).send({ error: 'episode has ended' });
    const { pageUrl, ...payload } = parsed.data;
    const e = store.ingest({
      eventType: 'tool.call',
      role: id.role,
      delegationId: id.delegationId,
      pageUrl,
      payload,
    });
    return { seq: e?.seq ?? null };
  });

  app.get('/v1/delegations/:id', async (req, reply) => {
    const t = bearer(req);
    const id = t ? registry.authenticate(t) : null;
    if (!id) return reply.code(401).send({ error: 'unauthorized' });
    const dlg = (req.params as { id: string }).id;
    const store = id.handle.store;
    const d = store.state().delegations.find((x) => x.delegationId === dlg);
    // Only the delegating role (never the child itself or another delegation) may read it.
    if (!d || d.parentRole !== id.role || id.delegationId !== null)
      return reply.code(404).send({ error: 'not found' });
    const events = store.events();
    const ended = events.find(
      (e) => e.eventType === 'delegation.ended' && e.payload.delegationId === dlg,
    );
    const view: DelegationStatusView = {
      delegationId: dlg,
      status: d.status,
      finalResponse:
        ended && ended.eventType === 'delegation.ended' ? ended.payload.finalResponse : null,
      reports: events.flatMap((e) =>
        e.eventType === 'subagent.report' && e.payload.delegationId === dlg
          ? [
              {
                reportId: e.payload.reportId,
                summary: e.payload.summary,
                claimIds: e.payload.claimIds,
                reportedResources: e.payload.reportedResources,
              },
            ]
          : [],
      ),
    };
    return view;
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not found' }));
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode;
    reply
      .code(status && status >= 400 && status < 500 ? status : 500)
      .send({ error: 'request failed' });
  });
  return app;
}
