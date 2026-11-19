import type { AgentEpisodeView, JsonValue } from '@aab/protocol';

/** Paths of the world Agent API (apps/world agent-api.ts). Duplicated to avoid a dependency on the world app. */
export const AGENT_API = {
  episode: '/v1/episode',
  action: (name: string) => `/v1/actions/${encodeURIComponent(name)}`,
  toolCalls: '/v1/tool-calls',
  delegation: (id: string) => `/v1/delegations/${encodeURIComponent(id)}`,
  headers: { toolCallId: 'x-tool-call-id', pageUrl: 'x-page-url' },
} as const;

export interface ToolCallRecord {
  toolCallId: string;
  server: 'browser' | 'bench';
  tool: string;
  args: JsonValue;
  outcome: 'ok' | 'error';
  error: string | null;
  pageUrl?: string | null;
}

export interface DelegationStatus {
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

/**
 * Minimal client for the world Agent API, bound to one bearer token. Used by both MCP servers
 * and by the scripted reference agent's direct mode. The token never leaves this object.
 */
export class AgentApiClient {
  readonly #token: string;
  constructor(
    readonly baseUrl: string,
    token: string,
    private readonly timeoutMs = 30_000,
  ) {
    this.#token = token;
    if (!/^https?:\/\//.test(baseUrl)) throw new Error('agent API URL must be http(s)');
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown }> {
    const r = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { error: text.slice(0, 500) };
    }
    return { status: r.status, json };
  }

  async episode(): Promise<AgentEpisodeView> {
    const r = await this.request('GET', AGENT_API.episode);
    if (r.status !== 200) throw new Error(`agent API /v1/episode: HTTP ${r.status}`);
    return r.json as AgentEpisodeView;
  }

  /** Call a world operation. Denials are normal results (`ok: false`). */
  async call(
    action: string,
    request: unknown,
    ctx: { toolCallId?: string | null; pageUrl?: string | null } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (ctx.toolCallId) headers[AGENT_API.headers.toolCallId] = ctx.toolCallId;
    if (ctx.pageUrl) headers[AGENT_API.headers.pageUrl] = ctx.pageUrl;
    const r = await this.request('POST', AGENT_API.action(action), request ?? {}, headers);
    if (r.status !== 200) throw new Error(`agent API ${action}: HTTP ${r.status}`);
    return r.json;
  }

  /** Journal a tool call (best effort: a failure here never fails the tool). */
  async reportToolCall(rec: ToolCallRecord): Promise<void> {
    try {
      await this.request('POST', AGENT_API.toolCalls, { pageUrl: null, ...rec });
    } catch {
      /* journaling is best effort; the world journals the action itself regardless */
    }
  }

  async delegation(id: string): Promise<DelegationStatus | null> {
    const r = await this.request('GET', AGENT_API.delegation(id));
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error(`agent API delegation ${id}: HTTP ${r.status}`);
    return r.json as DelegationStatus;
  }
}

/**
 * Deterministic, IdSchema-compatible tool call ids: `tc-<server>-<role>[-<delegation>]-<n>`, so
 * identical runs produce identical journals (spec §12.10).
 */
export function toolCallIdFactory(
  server: 'browser' | 'bench',
  view: Pick<AgentEpisodeView, 'role' | 'delegationId'>,
): () => string {
  let n = 0;
  const who = view.delegationId ? `${view.role}-${view.delegationId}` : view.role;
  const prefix = `tc-${server}-${who}`;
  return () => `${prefix}-${(++n).toString().padStart(5, '0')}`;
}

/** Make an arbitrary value JSON-safe (journal payloads must be JsonValue). */
export function toJsonValue(v: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(v ?? null)) as JsonValue;
  } catch {
    return String(v);
  }
}
