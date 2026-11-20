import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCa } from '@aab/pki';
import { MitmProxy } from './proxy.js';
import { buildProxyPolicy } from './policy.js';
import {
  NetworkEventBuffer,
  ProxyControlClient,
  startProxyControl,
  type ProxyControlServer,
} from './control.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'aab-control-'));
const TOKEN = 'control-token-0123456789';
let proxy: MitmProxy;
let control: ProxyControlServer;
let client: ProxyControlClient;
const buffer = new NetworkEventBuffer();

beforeAll(async () => {
  const ca = await ensureCa(path.join(tmp, 'pki'));
  proxy = new MitmProxy({
    ca,
    policy: buildProxyPolicy(),
    upstream: { host: '127.0.0.1', port: 9 },
    sink: (e, ctx) => buffer.push(e, ctx),
  });
  control = await startProxyControl(proxy, { host: '127.0.0.1', port: 0, token: TOKEN, buffer });
  client = new ProxyControlClient(control.url, TOKEN);
});
afterAll(async () => {
  await control.close();
  await proxy.close();
  rmSync(tmp, { recursive: true, force: true });
});

function connect(port: number, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: target });
    req.on('connect', (res, s) => {
      s.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res) => resolve(res.statusCode ?? 0));
    req.on('error', reject);
    req.end();
  });
}

describe('proxy control endpoint', () => {
  it('refuses requests without the token', async () => {
    expect((await fetch(`${control.url}/v1/health`)).status).toBe(401);
    await expect(
      new ProxyControlClient(control.url, 'wrong-token-0000000000').health(),
    ).rejects.toThrow(/401/);
  });

  it('adds a per-episode browser listener at runtime (intercept-only), drains its events, removes it', async () => {
    const l = await client.addListener({
      episodeId: 'ep-ctl',
      role: 'parent',
      delegationId: null,
      host: '127.0.0.1',
      port: 0,
      purpose: 'browser',
    });
    expect(l).toMatchObject({ purpose: 'browser' });
    expect(await connect(l.port, 'api.anthropic.com:443')).toBe(403);
    const { events, next } = await client.events(0);
    expect(events).toEqual([
      expect.objectContaining({
        episodeId: 'ep-ctl',
        listenerPort: l.port,
        event: expect.objectContaining({
          eventType: 'network.denied',
          payload: expect.objectContaining({
            host: 'api.anthropic.com',
            listener: 'browser',
            reason: 'host_not_allowed',
          }),
        }),
      }),
    ]);
    expect((await client.events(next)).events).toEqual([]);
    await client.removeListener(l.port);
    await expect(connect(l.port, 'probe.eval.test:443')).rejects.toThrow();
  });
});
