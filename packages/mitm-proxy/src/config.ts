import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ProxyConfigSchema, type ProxyConfigInput, type ProxyListener } from '@aab/protocol';
import { caPaths, loadCa } from '@aab/pki';
import {
  MitmProxy,
  type AddListenerOptions,
  type BoundListener,
  type MitmProxyOptions,
} from './proxy.js';

export type FromConfigOptions = Omit<
  MitmProxyOptions,
  'ca' | 'policy' | 'upstream' | 'internalEndpoints' | 'upstreamSecret'
> & {
  /** Per-listener options (rarely needed: purpose and policy come from the listener spec). */
  listenerOptions?: (listener: ProxyListener) => AddListenerOptions | undefined;
  /**
   * Legacy: ports whose listeners serve a browser (purpose `browser` → intercept-only policy).
   * Prefer `purpose: 'browser'` on the listener in the config file.
   */
  interceptOnlyPorts?: readonly number[];
};

/** Read a secret file (trimmed). Throws if missing or shorter than 16 characters. */
export function readSecretFile(file: string): string {
  const v = readFileSync(file, 'utf8').trim();
  if (v.length < 16) throw new Error(`secret in ${file} must be at least 16 characters`);
  return v;
}

/**
 * Start a proxy from the protocol's `ProxyConfig`. `config.ca` must point at a PKI dir created by
 * `@aab/pki` (`ca.pem` / `ca-key.pem`; the shared leaf key is read from the same dir).
 */
export async function startMitmProxyFromConfig(
  config: ProxyConfigInput,
  opts: FromConfigOptions,
): Promise<{ proxy: MitmProxy; listeners: BoundListener[] }> {
  const cfg = ProxyConfigSchema.parse(config);
  const dir = path.dirname(path.resolve(cfg.ca.certPath));
  const p = caPaths(dir);
  if (path.resolve(cfg.ca.certPath) !== p.certPath || path.resolve(cfg.ca.keyPath) !== p.keyPath) {
    throw new Error(`ProxyConfig.ca must be ${p.certPath} + ${p.keyPath} (an @aab/pki directory)`);
  }
  const ca = await loadCa(dir);
  const { listenerOptions, interceptOnlyPorts, ...proxyOpts } = opts;
  const { secretFile, ...upstream } = cfg.worldSiteUpstream;
  const proxy = new MitmProxy({
    ...proxyOpts,
    ca,
    policy: cfg.policy,
    upstream,
    upstreamSecret: secretFile ? readSecretFile(secretFile) : null,
    internalEndpoints: cfg.internalEndpoints,
  });
  const listeners: BoundListener[] = [];
  try {
    for (const l of cfg.listeners) {
      const extra =
        listenerOptions?.(l) ??
        (interceptOnlyPorts?.includes(l.port) ? { purpose: 'browser' as const } : undefined);
      listeners.push(await proxy.addListener(l, extra));
    }
  } catch (e) {
    await proxy.close();
    throw e;
  }
  return { proxy, listeners };
}
