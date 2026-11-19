import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EVENT_PAYLOAD_SCHEMAS,
  TRUSTED_HEADERS,
  decideProxyAction,
  DEFAULT_PROXY_POLICY,
  type ProxyListener,
} from '@aab/protocol';
import { ensureCa, LeafMinter, type EvalCa } from '@aab/pki';
import {
  MitmProxy,
  buildProxyPolicy,
  createEventCollector,
  decide,
  interceptOnlyPolicy,
  isPrivateAddress,
  parseAuthority,
  type BoundListener,
  type EventCollector,
} from './index.js';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let tmp: string;
let ca: EvalCa;
let otherCa: EvalCa;
let upstream: http.Server;
let upstreamPort: number;
let admin: http.Server;
let adminPort: number;
let adminHits = 0;
let seen: Seen[] = [];
let slowAborted: Promise<void>;
let resolveSlowAborted: () => void;
let foreignTls: tls.Server;
let foreignPort: number;
let foreignPlaintext: string[] = [];
let proxy: MitmProxy;
let listener: BoundListener;
let events: EventCollector;

const LISTENER: ProxyListener = {
  episodeId: 'ep-1',
  role: 'parent',
  delegationId: null,
  host: '127.0.0.1',
  port: 0,
  purpose: 'any',
};

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'aab-mitm-'));
  ca = await ensureCa(path.join(tmp, 'pki'));
  otherCa = await ensureCa(path.join(tmp, 'other-pki'));

  upstream = http.createServer((req, res) => {
    if (req.url === '/slow') {
      res.once('close', () => resolveSlowAborted());
      return; // never answers
    }
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      res.setHeader('set-cookie', ['a=1', 'b=2']);
      res.end(JSON.stringify({ ok: true, host: req.headers.host, url: req.url }));
    });
  });
  upstream.on('upgrade', (req: http.IncomingMessage, socket: net.Socket) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: '' });
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake\r\n\r\n',
    );
    socket.on('data', (d: Buffer) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
  });
  upstreamPort = await listen(upstream);

  admin = http.createServer((_req, res) => {
    adminHits++;
    res.end('admin');
  });
  adminPort = await listen(admin);

  // A TLS server with a certificate from a *different* CA (stands in for a real model API).
  const foreignLeaf = await new LeafMinter(otherCa).mint('tunnel.eval.test');
  foreignTls = tls.createServer({ cert: foreignLeaf.chainPem, key: foreignLeaf.keyPem }, (s) => {
    s.on('data', (d: Buffer) => {
      foreignPlaintext.push(d.toString());
      s.write(`pong:${d.toString()}`);
    });
    s.on('error', () => {});
  });
  foreignTls.on('tlsClientError', () => {});
  foreignPort = await listen(foreignTls);
});

afterAll(async () => {
  await proxy?.close();
  upstream?.close();
  admin?.close();
  foreignTls?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makePolicy() {
  return buildProxyPolicy({
    presets: ['anthropic'],
    prependRules: [
      // Test-only: a passthrough route to the local foreign TLS server, and one that "rebinds".
      {
        match: { type: 'exact', host: 'tunnel.eval.test' },
        action: 'passthrough',
        ports: [foreignPort],
      },
      { match: { type: 'exact', host: 'rebind.example' }, action: 'passthrough', ports: [443] },
    ],
  });
}

beforeEach(async () => {
  await proxy?.close();
  seen = [];
  foreignPlaintext = [];
  adminHits = 0;
  slowAborted = new Promise((r) => (resolveSlowAborted = r));
  events = createEventCollector();
  proxy = new MitmProxy({
    ca,
    policy: makePolicy(),
    upstream: { host: '127.0.0.1', port: upstreamPort },
    internalEndpoints: [{ host: '127.0.0.1', port: adminPort }],
    allowedAddresses: [{ host: '127.0.0.1', port: foreignPort }],
    resolve: async (h) => (h === 'tunnel.eval.test' || h === 'rebind.example' ? ['127.0.0.1'] : []),
    sink: events.sink,
    maxHeaderSize: 8 * 1024,
    timeouts: { handshakeMs: 2000 },
  });
  listener = await proxy.addListener(LISTENER);
});

// ---------------------------------------------------------------------------
// client helpers (raw sockets so we control SNI / Host independently)
// ---------------------------------------------------------------------------

async function connectVia(
  authority: string,
): Promise<{ status: number; socket: net.Socket; head: string }> {
  const socket = net.connect(listener.port, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  let buf = '';
  while (!buf.includes('\r\n\r\n')) {
    const [d] = (await Promise.race([
      once(socket, 'data'),
      once(socket, 'close').then(() => [Buffer.from('')]),
    ])) as [Buffer];
    if (!d.length) break;
    buf += d.toString('latin1');
  }
  const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0);
  return { status, socket, head: buf };
}

async function readAll(s: net.Socket | tls.TLSSocket): Promise<string> {
  const chunks: Buffer[] = [];
  s.on('data', (d: Buffer) => chunks.push(d));
  await Promise.race([once(s, 'end'), once(s, 'close')]).catch(() => {});
  return Buffer.concat(chunks).toString();
}

interface RawResponse {
  status: number;
  headers: string;
  body: string;
  peerCert: tls.PeerCertificate | null;
  authorized: boolean;
}

async function httpsViaProxy(opts: {
  authority?: string;
  servername?: string;
  hostHeader?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  trust?: string;
}): Promise<RawResponse> {
  const authority = opts.authority ?? 'probe.eval.test:443';
  const { status, socket } = await connectVia(authority);
  if (status !== 200) throw new Error(`CONNECT ${status}`);
  const t = tls.connect({
    socket,
    servername: opts.servername ?? authority.split(':')[0],
    ca: opts.trust ?? ca.certPem,
    ALPNProtocols: ['h2', 'http/1.1'],
  });
  await once(t, 'secureConnect');
  const body = opts.body ?? '';
  const headers = {
    host: opts.hostHeader ?? authority.replace(/:443$/, ''),
    connection: 'close',
    ...(body ? { 'content-length': String(Buffer.byteLength(body)) } : {}),
    ...opts.headers,
  };
  t.write(
    `${opts.method ?? 'GET'} ${opts.path ?? '/'} HTTP/1.1\r\n` +
      Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('') +
      '\r\n' +
      body,
  );
  const peerCert = t.getPeerCertificate();
  const authorized = t.authorized;
  expect(t.alpnProtocol).toBe('http/1.1');
  const raw = await readAll(t);
  const [head = '', ...rest] = raw.split('\r\n\r\n');
  return {
    status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0),
    headers: head,
    body: rest.join('\r\n\r\n'),
    peerCert,
    authorized,
  };
}

async function plainViaProxy(target: string, extra = ''): Promise<{ status: number; raw: string }> {
  const socket = net.connect(listener.port, '127.0.0.1');
  await once(socket, 'connect');
  const u = new URL(target);
  socket.write(`GET ${target} HTTP/1.1\r\nHost: ${u.host}\r\nConnection: close\r\n${extra}\r\n`);
  const raw = await readAll(socket);
  return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0), raw };
}

function payloadValid(e: { eventType: keyof typeof EVENT_PAYLOAD_SCHEMAS; payload: unknown }) {
  EVENT_PAYLOAD_SCHEMAS[e.eventType].parse(e.payload);
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe('policy helpers', () => {
  it('decide() agrees with protocol decideProxyAction()', () => {
    const p = makePolicy();
    for (const [h, port, t] of [
      ['probe.eval.test', 443, 'connect'],
      ['probe.eval.test', 80, 'http'],
      ['probe.eval.test', 8443, 'connect'],
      ['api.anthropic.com', 443, 'connect'],
      ['api.anthropic.com', 80, 'http'],
      ['statsig.anthropic.com', 443, 'connect'],
      ['example.com', 443, 'connect'],
    ] as const) {
      expect(decide(p, h, port, t).action).toBe(decideProxyAction(p, h, port, t));
    }
    expect(decide(DEFAULT_PROXY_POLICY, 'api.openai.com', 443, 'connect').action).toBe(
      'passthrough',
    );
    expect(decide(p, 'probe.eval.test', 8443, 'connect')).toMatchObject({
      reason: 'port_not_allowed',
    });
    expect(decide(p, 'statsig.anthropic.com', 443, 'connect')).toMatchObject({
      reason: 'denied_by_rule',
    });
    expect(decide(p, 'example.com', 443, 'connect')).toMatchObject({ reason: 'host_not_allowed' });
    expect(interceptOnlyPolicy(p).rules.some((r) => r.action === 'passthrough')).toBe(false);
  });

  it('default presets tunnel both CLIs', () => {
    const p = buildProxyPolicy();
    for (const h of [
      'api.anthropic.com',
      'platform.claude.com',
      'api.openai.com',
      'chatgpt.com',
      'auth.openai.com',
    ]) {
      expect(decide(p, h, 443, 'connect').action).toBe('passthrough');
    }
    for (const h of [
      'ab.chatgpt.com',
      'statsig.anthropic.com',
      'downloads.claude.ai',
      'claude.ai',
    ]) {
      expect(decide(p, h, 443, 'connect').action).toBe('deny');
    }
    expect(decide(buildProxyPolicy({ presets: [] }), 'api.openai.com', 443, 'connect').action).toBe(
      'deny',
    );
  });

  it('parses authorities and classifies addresses', () => {
    expect(parseAuthority('Probe.Eval.Test.:443', null)).toEqual({
      host: 'probe.eval.test',
      port: 443,
    });
    expect(parseAuthority('[::1]:8080', null)).toEqual({ host: '::1', port: 8080 });
    expect(parseAuthority('example.com', null)).toBeNull();
    expect(parseAuthority('a:b:c', 80)).toBeNull();
    expect(parseAuthority('x.test:99999', null)).toBeNull();
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '0.0.0.0',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    expect(isPrivateAddress('93.184.216.34')).toBe(false);
  });
});

describe('intercept', () => {
  it('round-trips through TLS trusting only the eval CA, stripping and injecting headers', async () => {
    const r = await httpsViaProxy({
      path: '/hello?x=1',
      method: 'POST',
      body: 'abc',
      headers: {
        'x-bench-role': 'world',
        'X-Bench-Episode': 'spoofed',
        'x-forwarded-for': '6.6.6.6',
        'proxy-authorization': 'secret',
      },
    });
    expect(r.authorized).toBe(true);
    expect(r.peerCert?.subjectaltname).toBe('DNS:probe.eval.test');
    expect(new X509Certificate(r.peerCert!.raw).checkIssued(new X509Certificate(ca.certPem))).toBe(
      true,
    );
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({
      ok: true,
      host: 'probe.eval.test',
      url: '/hello?x=1',
    });
    expect(r.headers).toMatch(/set-cookie: a=1\r\nset-cookie: b=2/i);

    expect(seen).toHaveLength(1);
    const h = seen[0]!.headers;
    expect(seen[0]!.body).toBe('abc');
    expect(h.host).toBe('probe.eval.test');
    expect(h[TRUSTED_HEADERS.episode]).toBe('ep-1');
    expect(h[TRUSTED_HEADERS.role]).toBe('parent');
    expect(h[TRUSTED_HEADERS.delegation]).toBeUndefined();
    expect(h['x-forwarded-for']).toBeUndefined();
    expect(h['x-forwarded-proto']).toBe('https');
    expect(h['proxy-authorization']).toBeUndefined();

    const ev = await events.waitFor((e) => e.eventType === 'network.request');
    expect(ev.eventType).toBe('network.request');
    if (ev.eventType !== 'network.request') return;
    payloadValid(ev);
    expect(ev.role).toBe('parent');
    expect(ev.payload).toMatchObject({
      method: 'POST',
      url: 'https://probe.eval.test/hello?x=1',
      host: 'probe.eval.test',
      status: 200,
      bytesIn: 3,
      strippedHeaders: ['x-bench-episode', 'x-bench-role'],
    });
    expect(ev.payload.bytesOut).toBeGreaterThan(10);
    expect(h[TRUSTED_HEADERS.requestId]).toBe(ev.payload.requestId);
    expect(events.events[0]!.ctx).toMatchObject({ episodeId: 'ep-1', port: listener.port });
  });

  it('injects the delegation header for child listeners', async () => {
    const child = await proxy.addListener({
      ...LISTENER,
      role: 'funding_subagent',
      delegationId: 'del-1',
    });
    const prev = listener;
    listener = child;
    try {
      await httpsViaProxy({ path: '/c' });
    } finally {
      listener = prev;
    }
    expect(seen[0]!.headers[TRUSTED_HEADERS.role]).toBe('funding_subagent');
    expect(seen[0]!.headers[TRUSTED_HEADERS.delegation]).toBe('del-1');
    await expect(
      proxy.addListener({ ...LISTENER, role: 'funding_subagent', delegationId: 'del-1' }),
    ).rejects.toThrow(/already exists/);
  });

  it('does not trust a client that only trusts some other CA', async () => {
    await expect(httpsViaProxy({ trust: otherCa.certPem })).rejects.toThrow(
      /self-signed|unable to verify|certificate/i,
    );
  });

  it('refuses SNI that differs from the CONNECT authority', async () => {
    await expect(httpsViaProxy({ servername: 'shop-a.eval.test' })).rejects.toThrow();
    const ev = await events.waitFor((e) => e.eventType === 'network.denied');
    expect(ev.payload).toMatchObject({
      host: 'shop-a.eval.test',
      reason: 'sni_mismatch',
      transport: 'connect',
    });
    expect(seen).toHaveLength(0);
  });

  it('refuses an inner Host header that differs from the CONNECT authority', async () => {
    const r = await httpsViaProxy({ hostHeader: 'shop-a.eval.test' });
    expect(r.status).toBe(421);
    const ev = await events.waitFor((e) => e.eventType === 'network.denied');
    payloadValid(ev);
    expect(ev.payload).toMatchObject({ host: 'shop-a.eval.test', reason: 'host_mismatch' });
    expect(seen).toHaveLength(0);
  });

  it('refuses plaintext inside a CONNECT to an intercept host', async () => {
    const { status, socket } = await connectVia('probe.eval.test:443');
    expect(status).toBe(200);
    socket.write('GET / HTTP/1.1\r\nHost: probe.eval.test\r\n\r\n');
    await readAll(socket);
    const ev = await events.waitFor((e) => e.eventType === 'network.denied');
    expect(ev.payload).toMatchObject({ reason: 'unsupported_protocol', host: 'probe.eval.test' });
    expect(seen).toHaveLength(0);
  });

  it('relays WebSocket upgrades', async () => {
    const { socket } = await connectVia('probe.eval.test:443');
    const t = tls.connect({ socket, servername: 'probe.eval.test', ca: ca.certPem });
    await once(t, 'secureConnect');
    t.write(
      'GET /ws HTTP/1.1\r\nHost: probe.eval.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
        'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nx-bench-role: world\r\n\r\n',
    );
    const [first] = (await once(t, 'data')) as [Buffer];
    expect(first.toString()).toMatch(/^HTTP\/1\.1 101/);
    t.write('ping');
    const [echo] = (await once(t, 'data')) as [Buffer];
    expect(echo.toString()).toBe('echo:ping');
    t.destroy();
    const ev = await events.waitFor((e) => e.eventType === 'network.request');
    expect(ev.payload).toMatchObject({
      status: 101,
      url: 'wss://probe.eval.test/ws',
      strippedHeaders: ['x-bench-role'],
    });
    expect(seen[0]!.headers[TRUSTED_HEADERS.role]).toBe('parent');
    expect(seen[0]!.headers.upgrade).toBe('websocket');
  });

  it('propagates client aborts to the upstream', async () => {
    const { socket } = await connectVia('probe.eval.test:443');
    const t = tls.connect({ socket, servername: 'probe.eval.test', ca: ca.certPem });
    await once(t, 'secureConnect');
    t.write('GET /slow HTTP/1.1\r\nHost: probe.eval.test\r\n\r\n');
    await new Promise((r) => setTimeout(r, 100));
    t.destroy();
    await slowAborted;
    const ev = await events.waitFor((e) => e.eventType === 'network.request');
    expect(ev.payload).toMatchObject({ status: null, url: 'https://probe.eval.test/slow' });
  });

  it('rejects oversized headers with 431', async () => {
    const r = await httpsViaProxy({ headers: { 'x-big': 'a'.repeat(20_000) } });
    expect(r.status).toBe(431);
    expect(seen).toHaveLength(0);
  });

  it('serves plain http://*.eval.test through the upstream too', async () => {
    const r = await plainViaProxy('http://probe.eval.test/plain', 'x-bench-episode: evil\r\n');
    expect(r.status).toBe(200);
    expect(seen[0]!.headers[TRUSTED_HEADERS.episode]).toBe('ep-1');
    expect(seen[0]!.headers['x-forwarded-proto']).toBe('http');
  });
});

describe('deny', () => {
  it('refuses CONNECT to a non-allowlisted host and records it', async () => {
    const { status, socket } = await connectVia('example.com:443');
    socket.destroy();
    expect(status).toBe(403);
    const ev = await events.waitFor((e) => e.eventType === 'network.denied');
    payloadValid(ev);
    expect(ev).toMatchObject({
      role: 'parent',
      delegationId: null,
      payload: {
        host: 'example.com',
        port: 443,
        method: 'CONNECT',
        transport: 'connect',
        reason: 'host_not_allowed',
      },
    });
  });

  it('refuses plain HTTP to a non-allowlisted host', async () => {
    const r = await plainViaProxy('http://example.com/x');
    expect(r.status).toBe(403);
    const ev = await events.waitFor((e) => e.eventType === 'network.denied');
    expect(ev.payload).toMatchObject({
      host: 'example.com',
      transport: 'http',
      reason: 'host_not_allowed',
      url: 'http://example.com/x',
    });
  });

  it('uses denied_by_rule for known telemetry and port_not_allowed for odd ports', async () => {
    expect((await connectVia('statsig.anthropic.com:443')).status).toBe(403);
    expect((await connectVia('probe.eval.test:8443')).status).toBe(403);
    expect((await connectVia('api.anthropic.com:80')).status).toBe(403);
    const reasons = events.ofType('network.denied').map((e) => e.payload.reason);
    expect(reasons).toEqual(['denied_by_rule', 'port_not_allowed', 'port_not_allowed']);
  });

  it('refuses IP literals, loopback, localhost and the internal/admin endpoints', async () => {
    for (const a of [
      `127.0.0.1:${adminPort}`,
      `127.0.0.1:${upstreamPort}`,
      'localhost:443',
      '[::1]:443',
      '93.184.216.34:443',
      '10.0.0.1:443',
    ]) {
      expect((await connectVia(a)).status).toBe(403);
    }
    expect((await plainViaProxy(`http://127.0.0.1:${adminPort}/admin`)).status).toBe(403);
    expect((await plainViaProxy(`http://localhost:${upstreamPort}/`)).status).toBe(403);
    const reasons = events.ofType('network.denied').map((e) => e.payload.reason);
    expect(reasons).toEqual([
      'internal_endpoint',
      'internal_endpoint',
      'internal_endpoint',
      'internal_endpoint',
      'host_not_allowed',
      'internal_endpoint',
      'internal_endpoint',
      'internal_endpoint',
    ]);
    expect(adminHits).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('refuses origin-form requests sent straight to the proxy', async () => {
    const socket = net.connect(listener.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write('GET /admin HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    expect(await readAll(socket)).toMatch(/^HTTP\/1\.1 400/);
    expect(events.ofType('network.denied')[0]?.payload.reason).toBe('malformed_request');
  });

  it('refuses a plain request whose Host differs from the absolute URL', async () => {
    const socket = net.connect(listener.port, '127.0.0.1');
    await once(socket, 'connect');
    socket.write(
      'GET http://probe.eval.test/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n',
    );
    expect(await readAll(socket)).toMatch(/^HTTP\/1\.1 400/);
    expect(seen).toHaveLength(0);
  });

  it('refuses a passthrough host that resolves to a private address (rebinding)', async () => {
    expect((await connectVia('rebind.example:443')).status).toBe(403);
    const ev = await events.waitFor((e) => e.eventType === 'network.denied');
    expect(ev.payload).toMatchObject({ host: 'rebind.example', reason: 'internal_endpoint' });
  });
});

describe('passthrough', () => {
  it('tunnels blindly: the client sees the upstream certificate, the proxy never decrypts', async () => {
    const { status, socket } = await connectVia(`tunnel.eval.test:${foreignPort}`);
    expect(status).toBe(200);
    // The eval CA must NOT validate this connection — it is not ours to terminate.
    const t = tls.connect({ socket, servername: 'tunnel.eval.test', ca: otherCa.certPem });
    await once(t, 'secureConnect');
    expect(t.authorized).toBe(true);
    const peer = new X509Certificate(t.getPeerCertificate().raw);
    expect(peer.checkIssued(new X509Certificate(otherCa.certPem))).toBe(true);
    expect(peer.checkIssued(new X509Certificate(ca.certPem))).toBe(false);
    t.write('secret-model-request');
    const [d] = (await once(t, 'data')) as [Buffer];
    expect(d.toString()).toBe('pong:secret-model-request');
    t.end();
    const ev = await events.waitFor((e) => e.eventType === 'network.tunnel');
    payloadValid(ev);
    expect(ev.payload).toMatchObject({
      host: 'tunnel.eval.test',
      port: foreignPort,
      outcome: 'closed',
    });
    if (ev.eventType !== 'network.tunnel') return;
    expect(ev.payload.bytesUp).toBeGreaterThan(100); // ClientHello + record
    expect(ev.payload.bytesDown).toBeGreaterThan(100);
    expect(events.ofType('network.request')).toHaveLength(0);
    expect(foreignPlaintext).toEqual(['secret-model-request']);
  });

  it('close() destroys open tunnels and still records them', async () => {
    const { socket } = await connectVia(`tunnel.eval.test:${foreignPort}`);
    const t = tls.connect({ socket, servername: 'tunnel.eval.test', ca: otherCa.certPem });
    await once(t, 'secureConnect');
    t.on('error', () => {}); // ECONNRESET is the expected outcome
    const closed = new Promise((r) => t.once('close', r)); // events.once would reject on 'error'
    await proxy.close();
    await closed;
    const ev = await events.waitFor((e) => e.eventType === 'network.tunnel');
    expect(ev.payload).toMatchObject({ host: 'tunnel.eval.test' });
  });
});

/** Async: the proxy lives in this process, so a blocking spawnSync would deadlock it. */
async function curl(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)('curl', args, { encoding: 'utf8' });
    return { status: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { status: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

describe.skipIf(spawnSync('curl', ['--version']).status !== 0)('curl as a second client', () => {
  it('curl --proxy --cacert reaches probe.eval.test', async () => {
    const r = await curl([
      '-sS',
      '--max-time',
      '10',
      '--proxy',
      listener.url,
      '--cacert',
      ca.paths.certPath,
      '-H',
      'x-bench-role: world',
      'https://probe.eval.test/curl',
    ]);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, host: 'probe.eval.test', url: '/curl' });
    expect(seen[0]!.headers[TRUSTED_HEADERS.role]).toBe('parent');
  });

  it('curl without the eval CA fails verification', async () => {
    const r = await curl([
      '-sS',
      '--max-time',
      '10',
      '--proxy',
      listener.url,
      'https://probe.eval.test/',
    ]);
    expect(r.status).not.toBe(0);
    expect(seen).toHaveLength(0);
  });

  it('curl to a denied host gets a 403 from the proxy', async () => {
    const r = await curl([
      '-sS',
      '--max-time',
      '10',
      '--proxy',
      listener.url,
      'https://example.com/',
    ]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/403/);
  });
});

describe('startMitmProxyFromConfig', () => {
  it('accepts the docker example config and gives intercept-only listeners no passthrough', async () => {
    const { readFileSync } = await import('node:fs');
    const { ProxyConfigSchema } = await import('@aab/protocol');
    const { startMitmProxyFromConfig } = await import('./index.js');
    const example = ProxyConfigSchema.parse(
      JSON.parse(
        readFileSync(new URL('../../../docker/proxy.config.example.json', import.meta.url), 'utf8'),
      ),
    );
    // Generated by `bench up --compose`: no static listeners (added per episode via `control`),
    // a site-host secret file and a control endpoint on the harness network.
    expect(example.listeners).toEqual([]);
    expect(example.control).toMatchObject({ port: 8090, tokenFile: '/secrets/control-token' });
    expect(example.worldSiteUpstream.secretFile).toBe('/secrets/proxy-secret');

    const free = net.createServer();
    const port = await listen(free);
    await new Promise((r) => free.close(r));
    const collector = createEventCollector();
    const { proxy: p, listeners } = await startMitmProxyFromConfig(
      {
        ...example,
        listeners: [{ ...LISTENER, port }],
        worldSiteUpstream: { host: '127.0.0.1', port: upstreamPort, secretFile: null },
        ca: { certPath: ca.paths.certPath, keyPath: ca.paths.keyPath },
        control: null,
      },
      { sink: collector.sink, interceptOnlyPorts: [port] },
    );
    try {
      expect(listeners[0]).toMatchObject({ port, purpose: 'browser' });
      const s = net.connect(port, '127.0.0.1');
      await once(s, 'connect');
      s.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n');
      expect(await readAll(s)).toMatch(/^HTTP\/1\.1 403/);
      expect(collector.ofType('network.denied')[0]?.payload).toMatchObject({
        host: 'api.anthropic.com',
        reason: 'host_not_allowed',
      });
    } finally {
      await p.close();
    }
  });
});
