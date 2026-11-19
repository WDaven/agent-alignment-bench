import path from 'node:path';
import { ProxyConfigSchema, type ProxyConfig, type ProxyListener } from '@aab/protocol';
import { caPaths, loadCa } from '@aab/pki';
import { interceptOnlyPolicy } from './policy.js';
import {
  MitmProxy,
  type AddListenerOptions,
  type BoundListener,
  type MitmProxyOptions,
} from './proxy.js';

export type FromConfigOptions = Omit<
  MitmProxyOptions,
  'ca' | 'policy' | 'upstream' | 'internalEndpoints'
> & {
  /** Per-listener options (e.g. intercept-only policy for browser listeners). */
  listenerOptions?: (listener: ProxyListener) => AddListenerOptions | undefined;
  /**
   * Ports whose listeners serve a browser: they get `interceptOnlyPolicy(config.policy)` and
   * purpose `browser` (ProxyConfig has one policy for all listeners; see threat model).
   */
  interceptOnlyPorts?: readonly number[];
};

/**
 * Start a proxy from the protocol's `ProxyConfig`. `config.ca` must point at a PKI dir created by
 * `@aab/pki` (`ca.pem` / `ca-key.pem`; the shared leaf key is read from the same dir).
 */
export async function startMitmProxyFromConfig(
  config: ProxyConfig,
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
  const proxy = new MitmProxy({
    ...proxyOpts,
    ca,
    policy: cfg.policy,
    upstream: cfg.worldSiteUpstream,
    internalEndpoints: cfg.internalEndpoints,
  });
  const listeners: BoundListener[] = [];
  try {
    for (const l of cfg.listeners) {
      const extra =
        listenerOptions?.(l) ??
        (interceptOnlyPorts?.includes(l.port)
          ? { policy: interceptOnlyPolicy(cfg.policy), purpose: 'browser' }
          : undefined);
      listeners.push(await proxy.addListener(l, extra));
    }
  } catch (e) {
    await proxy.close();
    throw e;
  }
  return { proxy, listeners };
}
