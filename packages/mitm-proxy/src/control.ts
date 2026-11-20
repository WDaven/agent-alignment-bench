import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROXY_CONTROL_PATHS, ProxyListenerSchema } from '@aab/protocol';
import type { NetworkEventContext, NetworkEventDraft } from './events.js';
import type { MitmProxy } from './proxy.js';

export interface BufferedNetworkEvent {
  n: number;
  episodeId: string;
  listenerPort: number;
  event: NetworkEventDraft;
}

export class NetworkEventBuffer {
  private readonly items: BufferedNetworkEvent[] = [];
  private next = 1;
  dropped = 0;
  constructor(private readonly capacity = 50_000) {}

  push(event: NetworkEventDraft, ctx: NetworkEventContext): void {
    this.items.push({ n: this.next++, episodeId: ctx.episodeId, listenerPort: ctx.port, event });
    while (this.items.length > this.capacity) {
      this.items.shift();
      this.dropped += 1;
    }
  }

  after(n: number, limit = 1000): { events: BufferedNetworkEvent[]; next: number } {
    const events = this.items.filter((e) => e.n > n).slice(0, limit);
    return { events, next: events.at(-1)?.n ?? n };
  }
}

function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}

async function readBody(req: http.IncomingMessage, max = 64 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new Error('body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim() ? JSON.parse(text) : {};
}

export interface ProxyControlServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startProxyControl(
  proxy: MitmProxy,
  opts: { host: string; port: number; token: string; buffer: NetworkEventBuffer },
): Promise<ProxyControlServer> {
  if (opts.token.length < 16) throw new Error('control token must be at least 16 characters');
  const send = (res: http.ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    void (async () => {
      const auth = req.headers.authorization;
      const m = typeof auth === 'string' ? /^Bearer\s+(\S+)$/i.exec(auth.trim()) : null;
      const presented = m?.[1];
      if (presented === undefined || !sameSecret(presented, opts.token))
        return send(res, 401, { error: 'unauthorized' });
      const url = new URL(req.url ?? '/', 'http://control');
      const listenerMatch = /^\/v1\/listeners\/(\d+)$/.exec(url.pathname);
      try {
        if (req.method === 'GET' && url.pathname === PROXY_CONTROL_PATHS.health)
          return send(res, 200, { ok: true, listeners: proxy.boundListeners.length });
        if (req.method === 'GET' && url.pathname === PROXY_CONTROL_PATHS.listeners)
          return send(res, 200, {
            listeners: proxy.boundListeners.map(({ policy: _p, ...l }) => l),
          });
        if (req.method === 'POST' && url.pathname === PROXY_CONTROL_PATHS.listeners) {
          const spec = ProxyListenerSchema.parse(await readBody(req));
          const bound = await proxy.addListener(spec);
          const { policy: _p, ...rest } = bound;
          return send(res, 201, rest);
        }
        if (req.method === 'DELETE' && listenerMatch) {
          await proxy.removeListener(Number(listenerMatch[1]));
          return send(res, 204);
        }
        if (req.method === 'GET' && url.pathname === PROXY_CONTROL_PATHS.events) {
          const after = Number(url.searchParams.get('after') ?? '0') || 0;
          return send(res, 200, { ...opts.buffer.after(after), dropped: opts.buffer.dropped });
        }
        return send(res, 404, { error: 'not found' });
      } catch (err) {
        return send(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://${opts.host}:${port}`,
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export class ProxyControlClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (r.status >= 300)
      throw new Error(`proxy control ${method} ${path}: ${r.status} ${await r.text()}`);
    return (r.status === 204 ? undefined : await r.json()) as T;
  }

  health() {
    return this.call<{ ok: boolean }>('GET', PROXY_CONTROL_PATHS.health);
  }
  addListener(spec: unknown) {
    return this.call<{ port: number; url: string; purpose: string }>(
      'POST',
      PROXY_CONTROL_PATHS.listeners,
      spec,
    );
  }
  removeListener(port: number) {
    return this.call<void>('DELETE', PROXY_CONTROL_PATHS.listener(port));
  }
  events(after: number) {
    return this.call<{ events: BufferedNetworkEvent[]; next: number; dropped: number }>(
      'GET',
      `${PROXY_CONTROL_PATHS.events}?after=${after}`,
    );
  }
}
