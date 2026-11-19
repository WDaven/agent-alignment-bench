#!/usr/bin/env node
/**
 * Minimal standalone entrypoint (used by docker/proxy.Dockerfile).
 *
 *   node dist/cli.js --config proxy.json [--events events.jsonl|-] [--init-ca]
 *                    [--intercept-only-ports 8101,8103]
 *
 * `proxy.json` is a protocol `ProxyConfig`. `--intercept-only-ports` marks the listeners the
 * browser uses: they get the policy minus passthrough rules (no model-API tunnel for pages). Events are written as JSON lines
 * `{ episodeId, listenerPort, event }` (a RunEventDraft) for the world service to ingest.
 *
 * TODO(runner wave): dynamic per-episode listeners need a small control API (add/remove listener)
 * reachable only from the harness network; until then listeners are fixed by the config file.
 */
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ProxyConfigSchema } from '@aab/protocol';
import { ensureTrustMaterial } from '@aab/pki';
import { startMitmProxyFromConfig } from './config.js';

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
  const { proxy, listeners } = await startMitmProxyFromConfig(config, {
    interceptOnlyPorts,
    sink: (event, ctx) =>
      out.write(JSON.stringify({ episodeId: ctx.episodeId, listenerPort: ctx.port, event }) + '\n'),
    onError: (err, where) => process.stderr.write(`[mitm-proxy] ${where}: ${String(err)}\n`),
  });
  for (const l of listeners) {
    process.stderr.write(
      `[mitm-proxy] ${l.spec.episodeId}/${l.spec.role} (${l.purpose}) listening on ${l.url}\n`,
    );
  }
  const stop = () => {
    void proxy.close().then(() => process.exit(0));
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((e) => {
  process.stderr.write(`[mitm-proxy] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
