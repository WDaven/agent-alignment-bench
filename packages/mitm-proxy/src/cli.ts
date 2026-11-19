#!/usr/bin/env node
/**
 * Standalone proxy process (used by docker/proxy.Dockerfile).
 *
 *   node dist/cli.js --config proxy.json [--events events.jsonl|-] [--init-ca]
 *
 * `proxy.json` is a protocol `ProxyConfig`. Listener purpose decides policy: `browser` listeners
 * get the policy minus every passthrough rule. With `control` set, a token-protected control
 * endpoint adds/removes per-episode listeners at runtime and serves buffered network events
 * (`GET /v1/events?after=n`) for the runner to journal. Events are also written as JSON lines
 * `{ episodeId, listenerPort, event }` (a RunEventDraft) to `--events`.
 */
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ProxyConfigSchema } from '@aab/protocol';
import { ensureTrustMaterial } from '@aab/pki';
import { readSecretFile, startMitmProxyFromConfig } from './config.js';
import { NetworkEventBuffer, startProxyControl } from './control.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: 'string' },
      events: { type: 'string', default: '-' },
      'init-ca': { type: 'boolean', default: false },
      'intercept-only-ports': { type: 'string', default: '' },
    },
  });
  if (!values.config) throw new Error('--config <ProxyConfig.json> is required');
  const config = ProxyConfigSchema.parse(JSON.parse(await readFile(values.config, 'utf8')));
  if (values['init-ca']) await ensureTrustMaterial(path.dirname(path.resolve(config.ca.certPath)));
  const out =
    values.events === '-' ? process.stdout : createWriteStream(values.events!, { flags: 'a' });
  const interceptOnlyPorts = values['intercept-only-ports']!.split(',')
    .filter(Boolean)
    .map((p) => Number(p));
  const buffer = new NetworkEventBuffer();
  const { proxy, listeners } = await startMitmProxyFromConfig(config, {
    interceptOnlyPorts,
    sink: (event, ctx) => {
      buffer.push(event, ctx);
      out.write(JSON.stringify({ episodeId: ctx.episodeId, listenerPort: ctx.port, event }) + '\n');
    },
    onError: (err, where) => process.stderr.write(`[mitm-proxy] ${where}: ${String(err)}\n`),
  });
  for (const l of listeners) {
    process.stderr.write(
      `[mitm-proxy] ${l.spec.episodeId}/${l.spec.role} (${l.purpose}) listening on ${l.url}\n`,
    );
  }
  const control = config.control
    ? await startProxyControl(proxy, {
        host: config.control.host,
        port: config.control.port,
        token: readSecretFile(config.control.tokenFile),
        buffer,
      })
    : null;
  if (control) process.stderr.write(`[mitm-proxy] control endpoint on ${control.url}\n`);
  const stop = () => {
    void Promise.all([proxy.close(), control?.close()]).then(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((e) => {
  process.stderr.write(`[mitm-proxy] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
