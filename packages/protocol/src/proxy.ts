import { z } from 'zod';
import { AgentRoleSchema, EpisodeIdSchema, EVAL_DOMAIN } from './common.js';
import { NetworkPolicyActionSchema } from './events.js';

export const TRUSTED_HEADERS = {
  episode: 'x-bench-episode',
  role: 'x-bench-role',
  delegation: 'x-bench-delegation',
  requestId: 'x-bench-request-id',
  proxySecret: 'x-bench-proxy-secret',
} as const;
export type TrustedHeaderName = (typeof TRUSTED_HEADERS)[keyof typeof TRUSTED_HEADERS];

export const BENCH_HEADER_PREFIX = 'x-bench-';

export const DEFAULT_PASSTHROUGH_HOSTS: readonly string[] = ['api.anthropic.com', 'api.openai.com'];

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

export const ProxyRuleSchema = z
  .strictObject({
    match: HostMatchSchema,
    action: NetworkPolicyActionSchema,
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

export const ListenerPurposeSchema = z.enum(['browser', 'cli', 'any']);
export type ListenerPurpose = z.infer<typeof ListenerPurposeSchema>;

export const ProxyListenerSchema = z.strictObject({
  episodeId: EpisodeIdSchema,
  role: AgentRoleSchema,
  delegationId: z.string().nullable(),
  host: z.string().min(1),
  port: z.number().int().min(0).max(65535),
  purpose: ListenerPurposeSchema.default('any'),
});
export type ProxyListener = z.infer<typeof ProxyListenerSchema>;
export type ProxyListenerInput = z.input<typeof ProxyListenerSchema>;

export const ProxyConfigSchema = z.strictObject({
  listeners: z.array(ProxyListenerSchema),
  policy: ProxyPolicySchema,
  worldSiteUpstream: z.strictObject({
    host: z.string(),
    port: z.number().int().min(1).max(65535),
    secretFile: z.string().nullable().default(null),
  }),
  internalEndpoints: z.array(
    z.strictObject({ host: z.string(), port: z.number().int().min(1).max(65535) }),
  ),
  ca: z.strictObject({ certPath: z.string(), keyPath: z.string() }),
  control: z
    .strictObject({
      host: z.string().min(1),
      port: z.number().int().min(0).max(65535),
      tokenFile: z.string().min(1),
    })
    .nullable()
    .default(null),
});
export type ProxyConfig = z.infer<typeof ProxyConfigSchema>;
export type ProxyConfigInput = z.input<typeof ProxyConfigSchema>;

export const PROXY_CONTROL_PATHS = {
  listeners: '/v1/listeners',
  listener: (port: number) => `/v1/listeners/${port}`,
  events: '/v1/events',
  health: '/v1/health',
} as const;
