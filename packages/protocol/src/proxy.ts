import { z } from 'zod';
import { AgentRoleSchema, EpisodeIdSchema, EVAL_DOMAIN } from './common.js';
import { NetworkPolicyActionSchema } from './events.js';

/**
 * Headers the MITM proxy adds (after stripping any client-supplied `x-bench-*`) before forwarding
 * intercepted requests to the world service. Only these establish a browser request's identity.
 */
export const TRUSTED_HEADERS = {
  episode: 'x-bench-episode',
  role: 'x-bench-role',
  /** Set for child-agent listeners. */
  delegation: 'x-bench-delegation',
  /** Proxy-assigned request id, echoed in network.request. */
  requestId: 'x-bench-request-id',
} as const;
export type TrustedHeaderName = (typeof TRUSTED_HEADERS)[keyof typeof TRUSTED_HEADERS];

/** Every header with this prefix from a client is stripped by the proxy. */
export const BENCH_HEADER_PREFIX = 'x-bench-';

/** Default model-API passthrough hosts (blind CONNECT tunnel, never decrypted). */
export const DEFAULT_PASSTHROUGH_HOSTS: readonly string[] = ['api.anthropic.com', 'api.openai.com'];

/**
 * Host matcher. `exact` matches one host; `suffix` matches the domain and all sub-domains
 * (`suffix: eval.test` matches `eval.test` and `a.b.eval.test`).
 */
export const HostMatchSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('exact'), host: z.string().min(1) }),
  z.strictObject({ type: z.literal('suffix'), domain: z.string().min(1) }),
]);
export type HostMatch = z.infer<typeof HostMatchSchema>;

export function hostMatches(m: HostMatch, host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (m.type === 'exact') return h === m.host.toLowerCase();
  const d = m.domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/**
 * Ordered rules; first match wins; no match = deny. `intercept` is only valid for hosts under
 * eval.test (the CA is name-constrained to it).
 */
export const ProxyRuleSchema = z
  .strictObject({
    match: HostMatchSchema,
    action: NetworkPolicyActionSchema,
    /** Allowed destination ports; null = 443 for CONNECT and 80 for plain HTTP. */
    ports: z.array(z.number().int().min(1).max(65535)).nullable(),
  })
  .superRefine((r, ctx) => {
    if (r.action !== 'intercept') return;
    const target = r.match.type === 'exact' ? r.match.host : r.match.domain;
    const t = target.toLowerCase();
    if (!(t === EVAL_DOMAIN || t.endsWith(`.${EVAL_DOMAIN}`))) {
      ctx.addIssue({
        code: 'custom',
        message: `intercept rules must target ${EVAL_DOMAIN}`,
        path: ['match'],
      });
    }
  });
export type ProxyRule = z.infer<typeof ProxyRuleSchema>;

export const ProxyPolicySchema = z.strictObject({
  rules: z.array(ProxyRuleSchema),
  /** Always deny; kept explicit so a config can't silently flip it. */
  defaultAction: z.literal('deny'),
});
export type ProxyPolicy = z.infer<typeof ProxyPolicySchema>;

export const DEFAULT_PROXY_POLICY: ProxyPolicy = {
  rules: [
    { match: { type: 'suffix', domain: EVAL_DOMAIN }, action: 'intercept', ports: null },
    ...DEFAULT_PASSTHROUGH_HOSTS.map((host) => ({
      match: { type: 'exact' as const, host },
      action: 'passthrough' as const,
      ports: [443],
    })),
  ],
  defaultAction: 'deny',
};

/** Decide the action for a host/port under a policy (pure helper shared by proxy and tests). */
export function decideProxyAction(
  policy: ProxyPolicy,
  host: string,
  port: number,
  transport: 'http' | 'connect',
): z.infer<typeof NetworkPolicyActionSchema> {
  for (const r of policy.rules) {
    if (!hostMatches(r.match, host)) continue;
    const ports = r.ports ?? [transport === 'connect' ? 443 : 80];
    return ports.includes(port) ? r.action : 'deny';
  }
  return policy.defaultAction;
}

/** One listener per role per episode; the port identifies the caller. */
export const ProxyListenerSchema = z.strictObject({
  episodeId: EpisodeIdSchema,
  role: AgentRoleSchema,
  delegationId: z.string().nullable(),
  /** Bind address, normally 127.0.0.1 (or 0.0.0.0 inside the proxy container). */
  host: z.string().min(1),
  /** 0 = pick a free port; the proxy reports the bound port. */
  port: z.number().int().min(0).max(65535),
});
export type ProxyListener = z.infer<typeof ProxyListenerSchema>;

export const ProxyConfigSchema = z.strictObject({
  listeners: z.array(ProxyListenerSchema).min(1),
  policy: ProxyPolicySchema,
  /** Where intercepted *.eval.test requests are forwarded (world site host listener). */
  worldSiteUpstream: z.strictObject({ host: z.string(), port: z.number().int().min(1).max(65535) }),
  /** Hosts:ports the proxy must never reach (world admin API, agent API). */
  internalEndpoints: z.array(
    z.strictObject({ host: z.string(), port: z.number().int().min(1).max(65535) }),
  ),
  ca: z.strictObject({ certPath: z.string(), keyPath: z.string() }),
});
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
