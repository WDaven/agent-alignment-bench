import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROBE_HOST, TRUSTED_HEADERS } from '@aab/protocol';
import { ensureTrustMaterial, trustEnv, type EvalCa } from '@aab/pki';
import {
  AGENT_CLI_QUIET_ENV,
  MitmProxy,
  buildProxyPolicy,
  createEventCollector,
  type BoundListener,
  type EventCollector,
} from '@aab/mitm-proxy';

let tmp: string;
let ca: EvalCa;
let world: http.Server;
const seen: http.IncomingHttpHeaders[] = [];
let proxy: MitmProxy;
let listener: BoundListener;
let events: EventCollector;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'aab-net-cli-'));
  ca = await ensureTrustMaterial(path.join(tmp, 'pki'));
  world = http.createServer((req, res) => {
    seen.push(req.headers);
    res.end(`hello ${req.headers.host}`);
  });
  world.listen(0, '127.0.0.1');
  await once(world, 'listening');
  events = createEventCollector();
  proxy = new MitmProxy({
    ca,
    policy: buildProxyPolicy(),
    upstream: { host: '127.0.0.1', port: (world.address() as net.AddressInfo).port },
    sink: events.sink,
  });
  listener = await proxy.addListener(
    { episodeId: 'ep-cli', role: 'parent', delegationId: null, host: '127.0.0.1', port: 0 },
    { purpose: 'cli' },
  );
});

afterAll(async () => {
  await proxy?.close();
  world?.close();
  rmSync(tmp, { recursive: true, force: true });
});

function harnessEnv(): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(
      ([k]) => !/proxy|ca_cert|ssl_cert|ca_bundle|cafile/i.test(k),
    ),
  );
  return {
    ...clean,
    ...AGENT_CLI_QUIET_ENV,
    ...trustEnv(ca.paths.dir),
    HTTPS_PROXY: listener.url,
    HTTP_PROXY: listener.url,
    https_proxy: listener.url,
    http_proxy: listener.url,
    NO_PROXY: '',
    no_proxy: '',
  };
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(cmd, args, { env, encoding: 'utf8', timeout: 20_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe.skipIf(spawnSync('curl', ['--version']).status !== 0)('curl with the harness env', () => {
  it('reaches probe.eval.test using CURL_CA_BUNDLE (a store-REPLACING variable → combined bundle)', async () => {
    const r = await run(
      'curl',
      ['-sS', '--max-time', '10', `https://${PROBE_HOST}/env`],
      harnessEnv(),
    );
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe(`hello ${PROBE_HOST}`);
    expect(seen.at(-1)?.[TRUSTED_HEADERS.episode]).toBe('ep-cli');
  });

  it('is refused for a non-allowlisted host and the denial is journaled', async () => {
    const r = await run('curl', ['-sS', '--max-time', '10', 'https://example.com/'], harnessEnv());
    expect(r.code).not.toBe(0);
    const d = events.ofType('network.denied').find((e) => e.payload.host === 'example.com');
    expect(d?.payload.reason).toBe('host_not_allowed');
  });

  it('cannot reach the telemetry hosts the CLIs know about', async () => {
    const r = await run(
      'curl',
      ['-sS', '--max-time', '10', 'https://statsig.anthropic.com/'],
      harnessEnv(),
    );
    expect(r.code).not.toBe(0);
    const d = events
      .ofType('network.denied')
      .find((e) => e.payload.host === 'statsig.anthropic.com');
    expect(d?.payload.reason).toBe('denied_by_rule');
  });
});

const nodeHasEnvProxy =
  process.versions.node.localeCompare('22.21.0', undefined, { numeric: true }) >= 0;

describe.skipIf(!nodeHasEnvProxy)(
  'node child with NODE_EXTRA_CA_CERTS + NODE_USE_ENV_PROXY',
  () => {
    it('fetch() reaches probe.eval.test through the proxy', async () => {
      const script = `fetch('https://${PROBE_HOST}/node').then(async (r) => console.log(r.status, await r.text()), (e) => { console.log('ERR', e.cause?.code ?? e.message); process.exit(3); })`;
      const r = await run(process.execPath, ['-e', script], {
        ...harnessEnv(),
        NODE_USE_ENV_PROXY: '1',
      });
      expect(r.stdout.trim()).toBe(`200 hello ${PROBE_HOST}`);
    });
  },
);
