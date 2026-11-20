import { lookup } from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import {
  BENCH_HEADER_PREFIX,
  ProxyListenerSchema,
  ProxyPolicySchema,
  TRUSTED_HEADERS,
  type ListenerPurpose,
  type NetworkDenialReason,
  type ProxyListener,
  type ProxyListenerInput,
  type ProxyPolicy,
} from '@aab/protocol';
import { LeafMinter, type EvalCa } from '@aab/pki';
import type { NetworkEventContext, NetworkEventDraft, NetworkEventSink } from './events.js';
import {
  decide,
  interceptOnlyPolicy,
  isLocalhostName,
  isPrivateAddress,
  normalizeHost,
  parseAuthority,
  type PolicyDecision,
} from './policy.js';

export interface HostPort {
  host: string;
  port: number;
}

export interface ProxyTimeouts {
  headersMs: number;
  requestMs: number;
  handshakeMs: number;
  connectMs: number;
  tunnelIdleMs: number;
  keepAliveMs: number;
  upstreamMs: number;
}

export const DEFAULT_TIMEOUTS: ProxyTimeouts = {
  headersMs: 30_000,
  requestMs: 120_000,
  handshakeMs: 10_000,
  connectMs: 10_000,
  tunnelIdleMs: 600_000,
  keepAliveMs: 30_000,
  upstreamMs: 120_000,
};

export interface MitmProxyOptions {
  ca: EvalCa;
  minter?: LeafMinter;
  policy: ProxyPolicy;
  upstream: HostPort;
  upstreamSecret?: string | null;
  internalEndpoints?: HostPort[];
  allowedAddresses?: { host: string; port: number | null }[];
  resolve?: (host: string) => Promise<string[]>;
  sink: NetworkEventSink;
  timeouts?: Partial<ProxyTimeouts>;
  maxHeaderSize?: number;
  onError?: (err: unknown, where: string) => void;
}

export interface AddListenerOptions {
  policy?: ProxyPolicy;
  purpose?: ListenerPurpose;
}

export interface BoundListener {
  spec: Readonly<ProxyListener>;
  purpose: ListenerPurpose;
  policy: ProxyPolicy;
  host: string;
  port: number;
  url: string;
}

interface ListenerState extends BoundListener {
  counters: { req: number; tun: number };
  outer: http.Server;
  inner: http.Server;
  sockets: Set<Duplex>;
  ctx: NetworkEventContext;
}

interface InterceptMeta {
  state: ListenerState;
  host: string;
  port: number;
  scheme: 'https' | 'http';
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

const STATUS_TEXT = http.STATUS_CODES;

function rawResponse(status: number, body: string, extra: Record<string, string> = {}): string {
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    connection: 'close',
    'x-bench-proxy': 'aab-mitm',
    ...extra,
  };
  return (
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? ''}\r\n` +
    Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join('') +
    '\r\n' +
    body
  );
}

function refererOf(headers: http.IncomingHttpHeaders): string | null {
  const r = headers.referer;
  if (typeof r !== 'string') return null;
  try {
    const u = new URL(r);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function defaultPort(scheme: 'http' | 'https'): number {
  return scheme === 'https' ? 443 : 80;
}

function withPrefix(socket: net.Socket, head: Buffer): Duplex {
  const d = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, enc, cb) {
      socket.write(chunk, enc, cb);
    },
    final(cb) {
      socket.end();
      cb();
    },
    destroy(err, cb) {
      socket.destroy(err ?? undefined);
      cb(err);
    },
  });
  d.push(head);
  socket.on('data', (c: Buffer) => {
    if (!d.push(c)) socket.pause();
  });
  socket.on('end', () => d.push(null));
  socket.on('error', (e) => d.destroy(e));
  socket.on('close', () => d.destroy());
  return d;
}

export class MitmProxy {
  readonly ca: EvalCa;
  readonly minter: LeafMinter;
  private readonly opts: MitmProxyOptions;
  private readonly timeouts: ProxyTimeouts;
  private readonly policy: ProxyPolicy;
  private readonly listeners = new Map<number, ListenerState>();
  private readonly meta = new WeakMap<object, InterceptMeta>();
  private closing = false;

  constructor(opts: MitmProxyOptions) {
    this.opts = opts;
    this.ca = opts.ca;
    this.minter = opts.minter ?? new LeafMinter(opts.ca);
    this.policy = ProxyPolicySchema.parse(opts.policy);
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...opts.timeouts };
    const up = this.opts.upstream;
    if ((opts.internalEndpoints ?? []).some((e) => sameEndpoint(e, up))) {
      throw new Error('upstream must not be an internal endpoint (world admin/agent API)');
    }
  }

  get boundListeners(): BoundListener[] {
    return [...this.listeners.values()].map(({ spec, purpose, policy, host, port, url }) => ({
      spec,
      purpose,
      policy,
      host,
      port,
      url,
    }));
  }

  async addListener(
    spec: ProxyListenerInput,
    opts: AddListenerOptions = {},
  ): Promise<BoundListener> {
    if (this.closing) throw new Error('proxy is closing');
    const parsed = ProxyListenerSchema.parse(spec);
    const purpose: ListenerPurpose =
      parsed.purpose === 'any' && opts.purpose ? opts.purpose : parsed.purpose;
    const listener: ProxyListener = { ...parsed, purpose };
    for (const l of this.listeners.values()) {
      if (
        l.spec.episodeId === listener.episodeId &&
        l.spec.role === listener.role &&
        l.spec.delegationId === listener.delegationId &&
        l.purpose === purpose
      ) {
        throw new Error(
          `listener for episode ${listener.episodeId} role ${listener.role} (${purpose}) already exists`,
        );
      }
    }
    const base = opts.policy ? ProxyPolicySchema.parse(opts.policy) : this.policy;
    const policy = purpose === 'browser' ? interceptOnlyPolicy(base) : base;
    const maxHeaderSize = this.opts.maxHeaderSize ?? 16 * 1024;
    const t = this.timeouts;
    const outer = http.createServer({
      maxHeaderSize,
      headersTimeout: t.headersMs,
      requestTimeout: t.requestMs,
      keepAliveTimeout: t.keepAliveMs,
    });
    const inner = http.createServer({
      maxHeaderSize,
      headersTimeout: t.headersMs,
      requestTimeout: t.requestMs,
      keepAliveTimeout: t.keepAliveMs,
    });
    const state: ListenerState = {
      spec: listener,
      purpose,
      host: listener.host,
      port: 0,
      url: '',
      policy,
      counters: { req: 0, tun: 0 },
      outer,
      inner,
      sockets: new Set(),
      ctx: { episodeId: listener.episodeId, listener, port: 0, purpose },
    };
    outer.on('connection', (s: net.Socket) => this.track(state, s));
    outer.on('request', (req, res) => this.onPlainRequest(state, req, res));
    outer.on('connect', (req, socket, head) =>
      this.onConnect(state, req, socket as net.Socket, head),
    );
    outer.on('upgrade', (req, socket, head) =>
      this.onPlainUpgrade(state, req, socket as net.Socket, head),
    );
    outer.on('clientError', (err, socket) => this.onClientError(state, err, socket, 'http'));
    inner.on('request', (req, res) => this.onInterceptedRequest(req, res));
    inner.on('upgrade', (req, socket, head) => this.onInterceptedUpgrade(req, socket, head));
    inner.on('clientError', (err, socket) => this.onClientError(state, err, socket, 'connect'));

    await new Promise<void>((resolve, reject) => {
      outer.once('error', reject);
      outer.listen(listener.port, listener.host, () => {
        outer.off('error', reject);
        resolve();
      });
    });
    outer.on('error', (e) => this.report(e, 'listener'));
    const addr = outer.address() as net.AddressInfo;
    state.port = addr.port;
    state.ctx = { ...state.ctx, port: addr.port };
    const urlHost = net.isIPv6(listener.host) ? `[${listener.host}]` : listener.host;
    state.url = `http://${urlHost}:${addr.port}`;
    this.listeners.set(addr.port, state);
    return {
      spec: listener,
      purpose,
      policy,
      host: listener.host,
      port: addr.port,
      url: state.url,
    };
  }

  async removeListener(port: number): Promise<void> {
    const s = this.listeners.get(port);
    if (!s) return;
    this.listeners.delete(port);
    await this.shutdown(s);
  }

  async close(): Promise<void> {
    this.closing = true;
    const all = [...this.listeners.values()];
    this.listeners.clear();
    await Promise.all(all.map((s) => this.shutdown(s)));
  }

  private async shutdown(s: ListenerState): Promise<void> {
    const closed = new Promise<void>((resolve) => s.outer.close(() => resolve()));
    for (const sock of s.sockets) sock.destroy();
    s.sockets.clear();
    s.outer.closeAllConnections();
    s.inner.closeAllConnections();
    await closed;
  }

  private track(state: ListenerState, s: Duplex): void {
    state.sockets.add(s);
    s.once('close', () => state.sockets.delete(s));
    s.on('error', () => {});
  }

  private report(err: unknown, where: string): void {
    try {
      this.opts.onError?.(err, where);
    } catch {}
  }

  private emit(state: ListenerState, event: NetworkEventDraft): void {
    try {
      this.opts.sink(event, state.ctx);
    } catch (e) {
      this.report(e, 'sink');
    }
  }

  private nextId(state: ListenerState, kind: 'req' | 'tun'): string {
    state.counters[kind] += 1;
    const who = state.spec.delegationId
      ? `${state.spec.role}-${state.spec.delegationId}`
      : state.spec.role;
    return `${kind}-${who}-${state.purpose}-${String(state.counters[kind]).padStart(6, '0')}`;
  }

  private envelope(state: ListenerState, pageUrl: string | null) {
    return { role: state.spec.role, delegationId: state.spec.delegationId, pageUrl } as const;
  }

  private emitDenied(
    state: ListenerState,
    d: {
      host: string;
      port: number | null;
      method: string | null;
      url: string | null;
      transport: 'http' | 'connect';
      reason: NetworkDenialReason;
    },
    pageUrl: string | null = null,
  ): void {
    this.emit(state, {
      ...this.envelope(state, pageUrl),
      eventType: 'network.denied',
      payload: { listener: state.purpose, ...d },
    });
  }

  private evaluate(
    state: ListenerState,
    host: string,
    port: number,
    transport: 'http' | 'connect',
  ): PolicyDecision {
    if ((this.opts.internalEndpoints ?? []).some((e) => sameEndpoint(e, { host, port }))) {
      return { action: 'deny', reason: 'internal_endpoint', rule: null };
    }
    if (sameEndpoint(this.opts.upstream, { host, port })) {
      return { action: 'deny', reason: 'internal_endpoint', rule: null };
    }
    const explicitlyAllowed = this.isAllowedAddress(host, port);
    if (isLocalhostName(host) && !explicitlyAllowed) {
      return { action: 'deny', reason: 'internal_endpoint', rule: null };
    }
    if (net.isIP(host) && !explicitlyAllowed) {
      return {
        action: 'deny',
        reason: isPrivateAddress(host) ? 'internal_endpoint' : 'host_not_allowed',
        rule: null,
      };
    }
    return decide(state.policy, host, port, transport);
  }

  private isAllowedAddress(host: string, port: number): boolean {
    return (this.opts.allowedAddresses ?? []).some(
      (a) => normalizeHost(a.host) === host && (a.port === null || a.port === port),
    );
  }

  private onPlainRequest(
    state: ListenerState,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const target = this.plainTarget(state, req);
    if (!target) {
      res.writeHead(400, { 'content-type': 'text/plain', connection: 'close' });
      res.end('malformed proxy request\n');
      return;
    }
    const { host, port, url } = target;
    const decision = this.evaluate(state, host, port, 'http');
    if (decision.action !== 'intercept') {
      const reason = decision.action === 'passthrough' ? 'unsupported_protocol' : decision.reason;
      this.emitDenied(
        state,
        { host, port, method: req.method ?? null, url: url.toString(), transport: 'http', reason },
        refererOf(req.headers),
      );
      res.writeHead(403, {
        'content-type': 'text/plain',
        connection: 'close',
        'x-bench-proxy': 'aab-mitm',
      });
      res.end(`blocked by eval proxy: ${reason}\n`);
      req.resume();
      return;
    }
    this.forward(state, { host, port, scheme: 'http' }, req, res, url.pathname + url.search);
  }

  private plainTarget(
    state: ListenerState,
    req: http.IncomingMessage,
  ): { host: string; port: number; url: URL } | null {
    const raw = req.url ?? '';
    let url: URL | null = null;
    try {
      url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? new URL(raw) : null;
    } catch {
      url = null;
    }
    const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : '';
    const deny = (host: string, port: number | null, reason: NetworkDenialReason) =>
      this.emitDenied(
        state,
        { host, port, method: req.method ?? null, url: raw || null, transport: 'http', reason },
        refererOf(req.headers),
      );
    if (!url) {
      deny(hostHeader || state.host, null, 'malformed_request');
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'ws:') {
      deny(url.hostname || hostHeader, null, 'unsupported_protocol');
      return null;
    }
    const a = parseAuthority(url.host, 80);
    if (!a) {
      deny(url.hostname, null, 'malformed_request');
      return null;
    }
    if (hostHeader) {
      const h = parseAuthority(hostHeader, 80);
      if (!h || h.host !== a.host || h.port !== a.port) {
        deny(a.host, a.port, h ? 'host_mismatch' : 'malformed_request');
        return null;
      }
    }
    return { host: a.host, port: a.port, url };
  }

  private onPlainUpgrade(
    state: ListenerState,
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ): void {
    const target = this.plainTarget(state, req);
    if (!target) {
      socket.end(rawResponse(400, 'malformed proxy request\n'));
      return;
    }
    const decision = this.evaluate(state, target.host, target.port, 'http');
    if (decision.action !== 'intercept') {
      const reason = decision.action === 'passthrough' ? 'unsupported_protocol' : decision.reason;
      this.emitDenied(
        state,
        {
          host: target.host,
          port: target.port,
          method: req.method ?? null,
          url: target.url.toString(),
          transport: 'http',
          reason,
        },
        refererOf(req.headers),
      );
      socket.end(rawResponse(403, `blocked by eval proxy: ${reason}\n`));
      return;
    }
    this.forwardUpgrade(
      state,
      { host: target.host, port: target.port, scheme: 'http' },
      req,
      socket,
      head,
      target.url.pathname + target.url.search,
    );
  }

  private onConnect(
    state: ListenerState,
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ): void {
    socket.on('error', () => {});
    const a = parseAuthority(req.url ?? '', null);
    if (!a) {
      this.emitDenied(state, {
        host: req.url ?? '',
        port: null,
        method: 'CONNECT',
        url: null,
        transport: 'connect',
        reason: 'malformed_request',
      });
      socket.end(rawResponse(400, 'malformed CONNECT authority\n'));
      return;
    }
    const decision = this.evaluate(state, a.host, a.port, 'connect');
    if (decision.action === 'deny') {
      this.emitDenied(state, {
        host: a.host,
        port: a.port,
        method: 'CONNECT',
        url: null,
        transport: 'connect',
        reason: decision.reason,
      });
      socket.end(rawResponse(403, `blocked by eval proxy: ${decision.reason}\n`));
      return;
    }
    if (decision.action === 'passthrough') {
      void this.tunnel(state, a, socket, head).catch((e) => {
        this.report(e, 'tunnel');
        socket.destroy();
      });
      return;
    }
    void this.interceptTls(state, a, socket, head).catch((e) => {
      this.report(e, 'intercept');
      socket.destroy();
    });
  }

  private async resolveTarget(host: string): Promise<string[]> {
    if (net.isIP(host)) return [host];
    if (this.opts.resolve) return this.opts.resolve(host);
    const r = await lookup(host, { all: true, verbatim: true });
    return r.map((x) => x.address);
  }

  private async tunnel(
    state: ListenerState,
    target: HostPort,
    client: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const tunnelId = this.nextId(state, 'tun');
    let bytesUp = head.length;
    let bytesDown = 0;
    let failed = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.emit(state, {
        ...this.envelope(state, null),
        eventType: 'network.tunnel',
        payload: {
          tunnelId,
          listener: state.purpose,
          host: target.host,
          port: target.port,
          outcome: failed ? 'error' : 'closed',
          bytesUp,
          bytesDown,
        },
      });
    };

    let addresses: string[];
    try {
      addresses = await this.resolveTarget(target.host);
    } catch {
      failed = true;
      client.end(rawResponse(502, 'upstream name resolution failed\n'));
      finish();
      return;
    }
    const address = addresses[0];
    const internal = (this.opts.internalEndpoints ?? []).some((e) =>
      addresses.some((ip) => sameEndpoint(e, { host: ip, port: target.port })),
    );
    if (
      !address ||
      internal ||
      addresses.some(
        (ip) =>
          isPrivateAddress(ip) && !this.isAllowedAddress(normalizeHost(ip) ?? ip, target.port),
      )
    ) {
      this.emitDenied(state, {
        host: target.host,
        port: target.port,
        method: 'CONNECT',
        url: null,
        transport: 'connect',
        reason: 'internal_endpoint',
      });
      client.end(rawResponse(403, 'blocked by eval proxy: internal_endpoint\n'));
      return;
    }

    const upstream = net.connect({ host: address, port: target.port });
    this.track(state, upstream);
    const connectTimer = setTimeout(
      () => upstream.destroy(new Error('connect timeout')),
      this.timeouts.connectMs,
    );
    let connected = false;
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
      finish();
    };
    upstream.once('error', () => {
      failed = true;
      if (!connected) {
        clearTimeout(connectTimer);
        upstream.destroy();
        client.end(rawResponse(502, 'upstream connect failed\n'));
        finish();
        return;
      }
      closeBoth();
    });
    client.once('error', () => {
      failed = true;
      closeBoth();
    });
    upstream.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.setTimeout(this.timeouts.tunnelIdleMs, closeBoth);
      upstream.setTimeout(this.timeouts.tunnelIdleMs, closeBoth);
      client.on('data', (d: Buffer) => (bytesUp += d.length));
      upstream.on('data', (d: Buffer) => (bytesDown += d.length));
      client.pipe(upstream);
      upstream.pipe(client);
    });
    client.once('close', closeBoth);
    upstream.once('close', () => {
      clearTimeout(connectTimer);
      if (connected) closeBoth();
    });
  }

  private async interceptTls(
    state: ListenerState,
    target: HostPort,
    client: net.Socket,
    head: Buffer,
  ): Promise<void> {
    let ctx: tls.SecureContext;
    try {
      ctx = await this.minter.secureContext(target.host);
    } catch (e) {
      this.report(e, 'mint');
      client.end(rawResponse(502, 'certificate minting failed\n'));
      return;
    }
    if (client.destroyed) return;
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    let sniMismatch: string | null = null;
    const transport: Duplex = head.length ? withPrefix(client, head) : client;
    const tlsSocket = new tls.TLSSocket(transport as net.Socket, {
      isServer: true,
      secureContext: ctx,
      ALPNProtocols: ['http/1.1'],
      SNICallback: (servername, cb) => {
        const sni = normalizeHost(servername);
        if (sni !== target.host) {
          sniMismatch = servername;
          cb(new Error(`SNI ${servername} does not match CONNECT ${target.host}`));
          return;
        }
        cb(null, ctx);
      },
    });
    this.track(state, tlsSocket);
    this.meta.set(tlsSocket, { state, host: target.host, port: target.port, scheme: 'https' });
    let secure = false;
    const hsTimer = setTimeout(() => {
      if (!secure) tlsSocket.destroy();
    }, this.timeouts.handshakeMs);
    tlsSocket.once('secure', () => {
      secure = true;
      clearTimeout(hsTimer);
    });
    tlsSocket.once('close', () => clearTimeout(hsTimer));
    tlsSocket.on('error', (err: NodeJS.ErrnoException) => {
      if (secure) return;
      clearTimeout(hsTimer);
      if (sniMismatch !== null) {
        this.emitDenied(state, {
          host: normalizeHost(sniMismatch) ?? sniMismatch,
          port: target.port,
          method: 'CONNECT',
          url: null,
          transport: 'connect',
          reason: 'sni_mismatch',
        });
      } else if (looksLikePlaintext(err)) {
        this.emitDenied(state, {
          host: target.host,
          port: target.port,
          method: 'CONNECT',
          url: null,
          transport: 'connect',
          reason: 'unsupported_protocol',
        });
      }
      tlsSocket.destroy();
      client.destroy();
    });
    client.once('close', () => tlsSocket.destroy());
    state.inner.emit('connection', tlsSocket);
  }

  private checkInner(
    req: http.IncomingMessage,
  ):
    | { meta: InterceptMeta; ok: true }
    | { meta: InterceptMeta | undefined; ok: false; status: number } {
    const meta = this.meta.get(req.socket);
    if (!meta) return { meta, ok: false, status: 500 };
    const { state } = meta;
    const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : '';
    const h = parseAuthority(hostHeader, defaultPort(meta.scheme));
    const url = `${meta.scheme}://${hostHeader || meta.host}${req.url ?? ''}`;
    if (!h || h.host !== meta.host || h.port !== meta.port) {
      this.emitDenied(
        state,
        {
          host: h?.host ?? (hostHeader || meta.host),
          port: h?.port ?? null,
          method: req.method ?? null,
          url,
          transport: 'connect',
          reason: h ? 'host_mismatch' : 'malformed_request',
        },
        refererOf(req.headers),
      );
      return { meta, ok: false, status: 421 };
    }
    const d = this.evaluate(state, meta.host, meta.port, 'connect');
    if (d.action !== 'intercept') {
      this.emitDenied(
        state,
        {
          host: meta.host,
          port: meta.port,
          method: req.method ?? null,
          url,
          transport: 'connect',
          reason: d.action === 'deny' ? d.reason : 'unsupported_protocol',
        },
        refererOf(req.headers),
      );
      return { meta, ok: false, status: 403 };
    }
    return { meta, ok: true };
  }

  private onInterceptedRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const c = this.checkInner(req);
    if (!c.ok) {
      res.writeHead(c.status, {
        'content-type': 'text/plain',
        connection: 'close',
        'x-bench-proxy': 'aab-mitm',
      });
      res.end(
        c.status === 421
          ? 'Host does not match the CONNECT authority\n'
          : 'blocked by eval proxy\n',
      );
      req.resume();
      return;
    }
    const { meta } = c;
    this.forward(meta.state, meta, req, res, req.url ?? '/');
  }

  private onInterceptedUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const c = this.checkInner(req);
    if (!c.ok) {
      socket.end(rawResponse(c.status, 'blocked by eval proxy\n'));
      return;
    }
    this.forwardUpgrade(c.meta.state, c.meta, req, socket, head, req.url ?? '/');
  }

  private upstreamHeaders(
    state: ListenerState,
    target: { host: string; port: number; scheme: 'http' | 'https' },
    req: http.IncomingMessage,
    requestId: string,
    keepUpgrade: boolean,
  ): { headers: Record<string, string | string[]>; stripped: string[] } {
    const connectionTokens = new Set(
      String(req.headers.connection ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    );
    const stripped: string[] = [];
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      const n = name.toLowerCase();
      if (n.startsWith(BENCH_HEADER_PREFIX)) {
        stripped.push(n);
        continue;
      }
      if (n === 'host' || n === 'forwarded' || n.startsWith('x-forwarded-')) continue;
      if (keepUpgrade && (n === 'upgrade' || n === 'connection')) continue;
      if (HOP_BY_HOP.has(n) || connectionTokens.has(n)) continue;
      headers[n] = value;
    }
    headers.host =
      target.port === defaultPort(target.scheme) ? target.host : `${target.host}:${target.port}`;
    headers['x-forwarded-proto'] = target.scheme;
    headers[TRUSTED_HEADERS.episode] = state.spec.episodeId;
    headers[TRUSTED_HEADERS.role] = state.spec.role;
    if (state.spec.delegationId !== null)
      headers[TRUSTED_HEADERS.delegation] = state.spec.delegationId;
    headers[TRUSTED_HEADERS.requestId] = requestId;
    if (this.opts.upstreamSecret) headers[TRUSTED_HEADERS.proxySecret] = this.opts.upstreamSecret;
    if (keepUpgrade) {
      headers.connection = 'Upgrade';
      headers.upgrade = String(req.headers.upgrade ?? '');
    }
    return { headers, stripped: [...new Set(stripped)].sort() };
  }

  private forward(
    state: ListenerState,
    target: { host: string; port: number; scheme: 'http' | 'https' },
    req: http.IncomingMessage,
    res: http.ServerResponse,
    path: string,
  ): void {
    const requestId = this.nextId(state, 'req');
    const { headers, stripped } = this.upstreamHeaders(state, target, req, requestId, false);
    const method = req.method ?? 'GET';
    const url = `${target.scheme}://${headers.host as string}${path}`;
    let bytesIn = 0;
    let bytesOut = 0;
    let status: number | null = null;
    let emitted = false;
    const finish = () => {
      if (emitted) return;
      emitted = true;
      this.emit(state, {
        ...this.envelope(state, refererOf(req.headers)),
        eventType: 'network.request',
        payload: {
          requestId,
          listener: state.purpose,
          method,
          url,
          host: target.host,
          status,
          bytesIn,
          bytesOut,
          strippedHeaders: stripped,
        },
      });
    };

    const up = http.request({
      host: this.opts.upstream.host,
      port: this.opts.upstream.port,
      method,
      path,
      headers,
      setHost: false,
      timeout: this.timeouts.upstreamMs,
    });
    up.on('socket', (s) => this.track(state, s));
    const fail = (code: number, msg: string) => {
      if (!res.headersSent) {
        status = code;
        res.writeHead(code, { 'content-type': 'text/plain', 'x-bench-proxy': 'aab-mitm' });
        res.end(msg);
      } else {
        res.destroy();
      }
      finish();
    };
    up.on('timeout', () => {
      up.destroy();
      fail(504, 'upstream timeout\n');
    });
    up.on('error', () => fail(502, 'upstream error\n'));
    up.on('response', (ures) => {
      status = ures.statusCode ?? 502;
      const out: Record<string, string | string[]> = {};
      const conn = new Set(
        String(ures.headers.connection ?? '')
          .split(',')
          .map((t) => t.trim().toLowerCase()),
      );
      for (const [k, v] of Object.entries(ures.headers)) {
        if (v === undefined || HOP_BY_HOP.has(k) || conn.has(k)) continue;
        out[k] = v;
      }
      res.writeHead(status, ures.statusMessage, out);
      ures.on('data', (d: Buffer) => (bytesOut += d.length));
      ures.pipe(res);
      ures.on('error', () => res.destroy());
    });
    req.on('data', (d: Buffer) => (bytesIn += d.length));
    req.pipe(up);
    res.on('close', () => {
      if (!res.writableFinished) up.destroy();
      finish();
    });
  }

  private forwardUpgrade(
    state: ListenerState,
    target: { host: string; port: number; scheme: 'http' | 'https' },
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    path: string,
  ): void {
    socket.pause();
    const requestId = this.nextId(state, 'req');
    const proto = String(req.headers.upgrade ?? '').toLowerCase();
    const hostValue =
      target.port === defaultPort(target.scheme) ? target.host : `${target.host}:${target.port}`;
    const url = `${target.scheme === 'https' ? 'wss' : 'ws'}://${hostValue}${path}`;
    if (proto !== 'websocket') {
      this.emitDenied(state, {
        host: target.host,
        port: target.port,
        method: req.method ?? null,
        url,
        transport: target.scheme === 'https' ? 'connect' : 'http',
        reason: 'unsupported_protocol',
      });
      socket.end(rawResponse(400, 'only websocket upgrades are supported\n'));
      return;
    }
    const { headers, stripped } = this.upstreamHeaders(state, target, req, requestId, true);
    let bytesIn = head.length;
    let bytesOut = 0;
    let status: number | null = null;
    let emitted = false;
    const finish = () => {
      if (emitted) return;
      emitted = true;
      this.emit(state, {
        ...this.envelope(state, refererOf(req.headers)),
        eventType: 'network.request',
        payload: {
          requestId,
          listener: state.purpose,
          method: req.method ?? 'GET',
          url,
          host: target.host,
          status,
          bytesIn,
          bytesOut,
          strippedHeaders: stripped,
        },
      });
    };
    socket.on('error', () => {});
    const up = http.request({
      host: this.opts.upstream.host,
      port: this.opts.upstream.port,
      method: req.method ?? 'GET',
      path,
      headers,
      setHost: false,
      timeout: this.timeouts.upstreamMs,
    });
    up.on('socket', (s) => this.track(state, s));
    up.on('error', () => {
      status = status ?? 502;
      socket.end(rawResponse(502, 'upstream error\n'));
      finish();
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('response', (ures) => {
      status = ures.statusCode ?? 502;
      const lines = [`HTTP/1.1 ${status} ${ures.statusMessage ?? ''}`];
      for (const [k, v] of headerPairs(ures.rawHeaders)) {
        if (HOP_BY_HOP.has(k.toLowerCase())) continue;
        lines.push(`${k}: ${v}`);
      }
      lines.push('connection: close');
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      ures.on('data', (d: Buffer) => {
        bytesOut += d.length;
        socket.write(d);
      });
      ures.on('end', () => socket.end());
      socket.once('close', finish);
    });
    up.on('upgrade', (ures, usock, uhead) => {
      status = ures.statusCode ?? 101;
      up.setTimeout(0);
      usock.setTimeout(0);
      this.track(state, usock);
      const lines = [`HTTP/1.1 ${status} ${ures.statusMessage ?? 'Switching Protocols'}`];
      for (const [k, v] of headerPairs(ures.rawHeaders)) lines.push(`${k}: ${v}`);
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (uhead.length) {
        bytesOut += uhead.length;
        socket.write(uhead);
      }
      if (head.length) usock.write(head);
      socket.on('data', (d: Buffer) => (bytesIn += d.length));
      usock.on('data', (d: Buffer) => (bytesOut += d.length));
      socket.pipe(usock);
      usock.pipe(socket);
      const close = () => {
        socket.destroy();
        usock.destroy();
        finish();
      };
      socket.once('end', close);
      usock.once('end', close);
      socket.once('close', close);
      usock.once('close', close);
      usock.on('error', close);
    });
    socket.once('close', () => {
      if (!emitted && status === null) {
        up.destroy();
        finish();
      }
    });
    up.end();
  }

  private onClientError(
    state: ListenerState,
    err: NodeJS.ErrnoException,
    socket: Duplex,
    transport: 'http' | 'connect',
  ): void {
    if (err.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    const tooLarge = err.code === 'HPE_HEADER_OVERFLOW';
    const timeout = err.code === 'ERR_HTTP_REQUEST_TIMEOUT';
    const meta = this.meta.get(socket);
    this.emitDenied(state, {
      host: meta?.host ?? '',
      port: meta?.port ?? null,
      method: null,
      url: null,
      transport,
      reason: 'malformed_request',
    });
    socket.end(rawResponse(tooLarge ? 431 : timeout ? 408 : 400, 'bad request\n'));
  }
}

function looksLikePlaintext(err: NodeJS.ErrnoException): boolean {
  const s = `${err.code ?? ''} ${err.message ?? ''}`.toLowerCase();
  return (
    s.includes('http_request') ||
    s.includes('http request') ||
    s.includes('wrong_version_number') ||
    s.includes('wrong version number') ||
    s.includes('unknown_protocol') ||
    s.includes('unknown protocol') ||
    s.includes('packet_length_too_long')
  );
}

function sameEndpoint(a: HostPort, b: HostPort): boolean {
  const ha = normalizeHost(a.host) ?? a.host.toLowerCase();
  const hb = normalizeHost(b.host) ?? b.host.toLowerCase();
  if (a.port !== b.port) return false;
  if (ha === hb) return true;
  const loop = (h: string) => h === 'localhost' || h === '::1' || /^127\./.test(h);
  return loop(ha) && loop(hb);
}

function headerPairs(raw: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    if (name !== undefined && value !== undefined) pairs.push([name, value]);
  }
  return pairs;
}
