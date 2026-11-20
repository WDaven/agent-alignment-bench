import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENT_PAYLOAD_SCHEMAS, PROBE_HOST, TRUSTED_HEADERS, type ProxyRule } from '@aab/protocol';
import { ensureCa, LeafMinter, type EvalCa } from '@aab/pki';
import {
  MitmProxy,
  buildProxyPolicy,
  createEventCollector,
  interceptOnlyPolicy,
  type BoundListener,
  type EventCollector,
} from '@aab/mitm-proxy';
import {
  connectToControlledBrowser,
  launchControlledBrowser,
  type ControlledBrowser,
} from '@aab/browser';

const T = 60_000;

let tmp: string;
let ca: EvalCa;
let otherCa: EvalCa;
let world: http.Server;
let worldPort: number;
const worldSeen: http.IncomingHttpHeaders[] = [];
let sentinel: http.Server;
let sentinelPort: number;
let sentinelHits = 0;
const rogue: Record<
  'selfSigned' | 'staplesCa' | 'staplesLeaf',
  { server: tls.Server; port: number }
> = {} as never;
let proxy: MitmProxy;
let listener: BoundListener;
let events: EventCollector;
let browser: ControlledBrowser;

function rogueRule(): ProxyRule {
  return {
    match: { type: 'exact', host: 'rogue.eval.test' },
    action: 'passthrough',
    ports: Object.values(rogue).map((r) => r.port),
  };
}

async function listen(server: net.Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as net.AddressInfo).port;
}

const PROBE_HTML = `<!doctype html><html><head><title>probe ok</title></head>
<body><h1 id="h">probe.eval.test</h1></body></html>`;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'aab-net-browser-'));
  ca = await ensureCa(path.join(tmp, 'pki'));
  otherCa = await ensureCa(path.join(tmp, 'other-pki'));

  world = http.createServer((req, res) => {
    worldSeen.push(req.headers);
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(PROBE_HTML);
  });
  worldPort = await listen(world);

  sentinel = http.createServer((_req, res) => {
    sentinelHits++;
    res.end('reached');
  });
  sentinelPort = await listen(sentinel);

  const foreign = await new LeafMinter(otherCa).mint('rogue.eval.test');
  const ourLeafCert = (await new LeafMinter(ca).mint('rogue.eval.test')).certPem;
  const chains = {
    selfSigned: foreign.chainPem,
    staplesCa: foreign.certPem + ca.certPem,
    staplesLeaf: foreign.certPem + ourLeafCert,
  };
  for (const [k, chain] of Object.entries(chains)) {
    const server = tls.createServer({ cert: chain, key: foreign.keyPem }, (s) => {
      s.on('error', () => {});
      s.once('data', () =>
        s.end(
          'HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 5\r\nconnection: close\r\n\r\nROGUE',
        ),
      );
    });
    server.on('tlsClientError', () => {});
    rogue[k as keyof typeof rogue] = { server, port: await listen(server) };
  }

  const rule = rogueRule();
  events = createEventCollector();
  proxy = new MitmProxy({
    ca,
    policy: {
      ...interceptOnlyPolicy(buildProxyPolicy()),
      rules: [rule, ...interceptOnlyPolicy(buildProxyPolicy()).rules],
    },
    upstream: { host: '127.0.0.1', port: worldPort },
    allowedAddresses: Object.values(rogue).map((r) => ({ host: '127.0.0.1', port: r.port })),
    resolve: async (h) => (h === 'rogue.eval.test' ? ['127.0.0.1'] : []),
    sink: events.sink,
  });
  listener = await proxy.addListener({
    episodeId: 'ep-net',
    role: 'parent',
    delegationId: null,
    host: '127.0.0.1',
    port: 0,
    purpose: 'any',
  });
  browser = await launchControlledBrowser({
    proxyPort: listener.port,
    caDir: ca.paths.dir,
    profileDir: path.join(tmp, 'profile'),
    artifactsDir: path.join(tmp, 'artifacts'),
    headless: true,
  });
}, T);

afterAll(async () => {
  await browser?.close();
  await proxy?.close();
  world?.close();
  sentinel?.close();
  for (const r of Object.values(rogue)) r.server.close();
  rmSync(tmp, { recursive: true, force: true });
});

function denials() {
  return events.ofType('network.denied');
}

describe('controlled Chromium through the MITM proxy', { timeout: T }, () => {
  it('launches with the hardening flags and a CDP endpoint on 127.0.0.1', async () => {
    for (const flag of [
      '--proxy-bypass-list=<-loopback>',
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-default-apps',
      '--disable-extensions',
      `--ignore-certificate-errors-spki-list=${browser.trustedSpki}`,
    ]) {
      expect(browser.args).toContain(flag);
    }
    expect(browser.args.some((a) => a === '--ignore-certificate-errors')).toBe(false);
    expect(browser.cdpEndpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const version = (await (await fetch(`${browser.cdpEndpoint}/json/version`)).json()) as Record<
      string,
      string
    >;
    expect(version.webSocketDebuggerUrl).toBe(browser.wsEndpoint);
    const attached = await connectToControlledBrowser(browser.cdpEndpoint);
    expect(attached.contexts().length).toBeGreaterThan(0);
    await attached.close();
  });

  it(`loads https://${PROBE_HOST} with no certificate error`, async () => {
    const page = await browser.page();
    const res = await page.goto(`https://${PROBE_HOST}/`);
    expect(res?.status()).toBe(200);
    expect(await page.title()).toBe('probe ok');
    const sec = await res?.securityDetails();
    expect(sec?.subjectName).toBe(PROBE_HOST);
    expect(sec?.issuer).toMatch(/Agent Alignment Bench Eval CA/);
    expect(worldSeen.at(-1)?.[TRUSTED_HEADERS.episode]).toBe('ep-net');
    expect(worldSeen.at(-1)?.[TRUSTED_HEADERS.role]).toBe('parent');
    const req = events.ofType('network.request').find((e) => e.payload.host === PROBE_HOST);
    expect(req?.payload.status).toBe(200);
    EVENT_PAYLOAD_SCHEMAS['network.request'].parse(req?.payload);
    await browser.screenshot('probe');
  });

  it('blocks https://example.com and records network.denied', async () => {
    const page = await browser.page();
    await expect(page.goto('https://example.com/')).rejects.toThrow(/ERR_TUNNEL_CONNECTION_FAILED/);
    const d = denials().find((e) => e.payload.host === 'example.com');
    expect(d?.payload).toMatchObject({
      port: 443,
      transport: 'connect',
      reason: 'host_not_allowed',
    });
    EVENT_PAYLOAD_SCHEMAS['network.denied'].parse(d?.payload);
  });

  it('sends loopback through the proxy too, where it is blocked', async () => {
    const page = await browser.page();
    const res = await page.goto(`http://127.0.0.1:${sentinelPort}/`).catch(() => null);
    if (res) {
      expect(res.status()).toBe(403);
      expect(res.headers()['x-bench-proxy']).toBe('aab-mitm');
    }
    expect(sentinelHits).toBe(0);
    const d = denials().find((e) => e.payload.port === sentinelPort);
    expect(d?.payload).toMatchObject({
      host: '127.0.0.1',
      transport: 'http',
      reason: 'internal_endpoint',
    });

    await page.goto(`http://localhost:${sentinelPort}/`).catch(() => null);
    expect(sentinelHits).toBe(0);
  });

  it('blocks and logs fetch() from the page to a non-allowlisted API', async () => {
    const page = await browser.context.newPage();
    await page.goto(`https://${PROBE_HOST}/`);
    const result = await page.evaluate(
      `fetch('https://api.not-allowed.example/v1/charge', { method: 'POST', body: 'x' })
         .then((r) => 'ok:' + r.status, (e) => 'err:' + e.message)`,
    );
    expect(result).toMatch(/^err:/);
    const d = await events.waitFor(
      (e) => e.eventType === 'network.denied' && e.payload.host === 'api.not-allowed.example',
    );
    expect(d.payload).toMatchObject({ transport: 'connect', reason: 'host_not_allowed' });
    await page.close();
  });

  it('does not trust a TLS server on an eval.test name whose cert is not from the eval CA', async () => {
    const page = await browser.page();
    await expect(page.goto(`https://rogue.eval.test:${rogue.selfSigned.port}/`)).rejects.toThrow(
      /ERR_CERT_AUTHORITY_INVALID/,
    );
    await expect(page.goto(`https://rogue.eval.test:${rogue.staplesCa.port}/`)).rejects.toThrow(
      /ERR_CERT_AUTHORITY_INVALID/,
    );
  });

  it('KNOWN LIMITATION: a peer that staples our public leaf cert passes the SPKI pin', async () => {
    const page = await browser.context.newPage();
    const res = await page
      .goto(`https://rogue.eval.test:${rogue.staplesLeaf.port}/`)
      .catch((e: Error) => e.message);
    await page.close();
    expect(typeof res === 'string' ? res : res?.status()).toBe(200);
  });

  it('browser listeners never tunnel: passthrough rules (model APIs, rogue route) are stripped', async () => {
    const full = buildProxyPolicy();
    const b = await proxy.addListener(
      {
        episodeId: 'ep-net',
        role: 'parent',
        delegationId: null,
        host: '127.0.0.1',
        port: 0,
        purpose: 'browser',
      },
      { policy: { ...full, rules: [rogueRule(), ...full.rules] } },
    );
    try {
      expect(b.policy.rules.some((r) => r.action === 'passthrough')).toBe(false);
      for (const target of [
        'api.anthropic.com:443',
        'chatgpt.com:443',
        'api.openai.com:443',
        `rogue.eval.test:${rogue.staplesLeaf.port}`,
      ]) {
        const status = await new Promise<number>((resolve, reject) => {
          const req = http.request({
            host: '127.0.0.1',
            port: b.port,
            method: 'CONNECT',
            path: target,
          });
          req.on('connect', (res, socket) => {
            socket.destroy();
            resolve(res.statusCode ?? 0);
          });
          req.on('response', (res) => resolve(res.statusCode ?? 0));
          req.on('error', reject);
          req.end();
        });
        expect(status, target).toBe(403);
      }
    } finally {
      await proxy.removeListener(b.port);
    }
  });

  it('close() writes trace + HAR and deletes the profile', async () => {
    const profile = browser.profileDir;
    expect(existsSync(profile)).toBe(true);
    await browser.close();
    expect(existsSync(profile)).toBe(false);
    expect(statSync(path.join(browser.artifactsDir, 'trace.zip')).size).toBeGreaterThan(0);
    expect(statSync(path.join(browser.artifactsDir, 'network.har')).size).toBeGreaterThan(0);
    expect(existsSync(path.join(browser.artifactsDir, 'screenshots', 'probe.png'))).toBe(true);
  });
});
