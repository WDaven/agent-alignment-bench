import { BlockList, isIP } from 'node:net';
import {
  EVAL_DOMAIN,
  ProxyPolicySchema,
  hostMatches,
  type NetworkDenialReason,
  type ProxyPolicy,
  type ProxyRule,
} from '@aab/protocol';

// ---------------------------------------------------------------------------
// Passthrough presets (blind CONNECT tunnels, never decrypted)
// ---------------------------------------------------------------------------

export interface PassthroughPreset {
  description: string;
  hosts: readonly string[];
}

/**
 * Hosts the agent CLIs need to reach their model API and refresh credentials. Determined from the
 * installed binaries (Claude Code 2.1.224, codex-cli 0.169.0): string tables + documented env.
 */
export const PASSTHROUGH_PRESETS = {
  /** Claude Code (`claude -p`): Messages API, `/api/oauth/*` on the same host, OAuth token refresh. */
  anthropic: {
    description: 'Claude Code model API + OAuth token refresh',
    hosts: ['api.anthropic.com', 'platform.claude.com', 'console.anthropic.com'],
  },
  /** Codex (`codex exec`): API-key mode, ChatGPT-login mode (`chatgpt.com/backend-api/codex`), token refresh. */
  openai: {
    description: 'Codex model API (API key or ChatGPT login) + token refresh',
    hosts: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
  },
  /** Only for an interactive first-time `claude` login; not needed for headless runs. */
  'anthropic-interactive-login': {
    description: 'claude.ai OAuth authorize page (interactive login only)',
    hosts: ['claude.ai'],
  },
} as const satisfies Record<string, PassthroughPreset>;
export type PassthroughPresetName = keyof typeof PASSTHROUGH_PRESETS;

export const DEFAULT_PASSTHROUGH_PRESETS: readonly PassthroughPresetName[] = [
  'anthropic',
  'openai',
];

/**
 * Telemetry / update / feature-flag hosts seen in the same binaries. They stay denied; listing them
 * as explicit `deny` rules makes the journal say `denied_by_rule` instead of `host_not_allowed`.
 */
export const OBSERVED_TELEMETRY_HOSTS = {
  anthropic: [
    'statsig.anthropic.com',
    'http-intake.logs.us5.datadoghq.com',
    'browser-intake-us5-datadoghq.com',
    'cdn.growthbook.io',
    'downloads.claude.ai', // auto-updater
    'storage.googleapis.com', // auto-updater (release bucket)
    'mcp-proxy.anthropic.com', // claude.ai connectors (MCP), not used by the harness
  ],
  openai: [
    'ab.chatgpt.com', // statsig OTLP metrics
    'persistent.oaistatic.com', // app/update feed
  ],
} as const;

/**
 * Environment that tells the CLIs not to try telemetry/update traffic in the first place (Claude
 * Code honours these; Codex telemetry is configured in its config.toml `[otel]`, off by default).
 */
export const AGENT_CLI_QUIET_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_BUG_COMMAND: '1',
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: '1',
};

export interface BuildPolicyOptions {
  /** Presets to tunnel (default `DEFAULT_PASSTHROUGH_PRESETS`). `[]` = no passthrough at all. */
  presets?: readonly PassthroughPresetName[];
  /** Additional exact passthrough hosts (port 443). */
  extraPassthroughHosts?: readonly string[];
  /** Hosts to drop from the preset set. */
  removePassthroughHosts?: readonly string[];
  /** Add explicit deny rules for `OBSERVED_TELEMETRY_HOSTS` (default true). */
  denyTelemetry?: boolean;
  /** Additional explicit deny hosts (exact). */
  extraDenyHosts?: readonly string[];
  /** Rules inserted first (highest priority), e.g. test-only routes. */
  prependRules?: readonly ProxyRule[];
}

/** Build a validated `ProxyPolicy`: intercept *.eval.test, explicit denies, passthrough presets. */
export function buildProxyPolicy(opts: BuildPolicyOptions = {}): ProxyPolicy {
  const presets = opts.presets ?? DEFAULT_PASSTHROUGH_PRESETS;
  const remove = new Set((opts.removePassthroughHosts ?? []).map((h) => h.toLowerCase()));
  const passHosts = [
    ...new Set([
      ...presets.flatMap((p) => PASSTHROUGH_PRESETS[p].hosts),
      ...(opts.extraPassthroughHosts ?? []),
    ]),
  ]
    .map((h) => h.toLowerCase())
    .filter((h) => !remove.has(h));
  const denyHosts = [
    ...new Set([
      ...(opts.denyTelemetry === false
        ? []
        : [...OBSERVED_TELEMETRY_HOSTS.anthropic, ...OBSERVED_TELEMETRY_HOSTS.openai]),
      ...(opts.extraDenyHosts ?? []),
    ]),
  ];
  const rules: ProxyRule[] = [
    ...(opts.prependRules ?? []),
    { match: { type: 'suffix', domain: EVAL_DOMAIN }, action: 'intercept', ports: null },
    ...denyHosts.map((host): ProxyRule => ({
      match: { type: 'exact', host },
      action: 'deny',
      ports: null,
    })),
    ...passHosts.map((host): ProxyRule => ({
      match: { type: 'exact', host },
      action: 'passthrough',
      ports: [443],
    })),
  ];
  return ProxyPolicySchema.parse({ rules, defaultAction: 'deny' });
}

/**
 * The same policy without passthrough rules. Use it for the listener the *browser* talks to, so
 * that the page cannot reach chatgpt.com / claude.ai etc. through the CLI's model-API tunnel.
 */
export function interceptOnlyPolicy(policy: ProxyPolicy): ProxyPolicy {
  return { ...policy, rules: policy.rules.filter((r) => r.action !== 'passthrough') };
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export type PolicyDecision =
  | { action: 'intercept'; rule: ProxyRule }
  | { action: 'passthrough'; rule: ProxyRule }
  | { action: 'deny'; reason: NetworkDenialReason; rule: ProxyRule | null };

/**
 * Same semantics as protocol's `decideProxyAction` (first match wins, null ports = 443/80, no
 * match = deny) but also says *why* a request is denied.
 */
export function decide(
  policy: ProxyPolicy,
  host: string,
  port: number,
  transport: 'http' | 'connect',
): PolicyDecision {
  for (const rule of policy.rules) {
    if (!hostMatches(rule.match, host)) continue;
    const ports = rule.ports ?? [transport === 'connect' ? 443 : 80];
    if (!ports.includes(port)) return { action: 'deny', reason: 'port_not_allowed', rule };
    if (rule.action === 'deny') return { action: 'deny', reason: 'denied_by_rule', rule };
    return rule.action === 'intercept'
      ? { action: 'intercept', rule }
      : { action: 'passthrough', rule };
  }
  return { action: 'deny', reason: 'host_not_allowed', rule: null };
}

// ---------------------------------------------------------------------------
// Host / address helpers
// ---------------------------------------------------------------------------

const DNS_HOST_RE =
  /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)(\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*$/;

/** Lower-case, strip a trailing dot and IPv6 brackets. Returns null for garbage. */
export function normalizeHost(raw: string): string | null {
  let h = raw.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/\.$/, '');
  if (!h) return null;
  if (isIP(h)) return h;
  return DNS_HOST_RE.test(h) ? h : null;
}

/** Parse `host:port` / `[v6]:port` (CONNECT authority or Host header). */
export function parseAuthority(
  authority: string,
  defaultPort: number | null,
): { host: string; port: number } | null {
  const a = authority.trim();
  let hostPart: string;
  let portPart: string | undefined;
  if (a.startsWith('[')) {
    const end = a.indexOf(']');
    if (end < 0) return null;
    hostPart = a.slice(0, end + 1);
    const rest = a.slice(end + 1);
    if (rest) {
      if (!rest.startsWith(':')) return null;
      portPart = rest.slice(1);
    }
  } else {
    const i = a.lastIndexOf(':');
    if (i >= 0 && a.indexOf(':') !== i) return null; // bare IPv6 without brackets
    hostPart = i >= 0 ? a.slice(0, i) : a;
    portPart = i >= 0 ? a.slice(i + 1) : undefined;
  }
  const host = normalizeHost(hostPart);
  if (!host) return null;
  let port: number;
  if (portPart === undefined) {
    if (defaultPort === null) return null;
    port = defaultPort;
  } else {
    if (!/^\d{1,5}$/.test(portPart)) return null;
    port = Number(portPart);
  }
  if (port < 1 || port > 65535) return null;
  return { host, port };
}

const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
] as const) {
  PRIVATE.addSubnet(net, prefix, 'ipv6');
}

/** True for loopback, private, link-local, CGNAT, multicast, unspecified (v4, v6, v4-mapped). */
export function isPrivateAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return PRIVATE.check(ip, 'ipv4');
  if (fam === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return PRIVATE.check(mapped[1]!, 'ipv4');
    return PRIVATE.check(ip, 'ipv6');
  }
  return false;
}

/** `localhost` and `*.localhost` always mean this machine (RFC 6761). */
export function isLocalhostName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}
