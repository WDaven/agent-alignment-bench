import { z } from 'zod';
import { AgentRoleSchema, EpisodeIdSchema, UrlSchema } from './common.js';
import type { AgentEpisodeView } from './episode.js';
import { ToolCostSchema, type AgentInfo } from './run.js';

/** Name of the two MCP servers every agent gets (architecture.md). */
export const McpServerNameSchema = z.enum(['browser', 'bench']);
export type McpServerName = z.infer<typeof McpServerNameSchema>;

export const McpTransportSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()),
  }),
  z.strictObject({
    kind: z.literal('http'),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
  }),
]);
export type McpTransport = z.infer<typeof McpTransportSchema>;

export const McpServerSpecSchema = z.strictObject({
  name: McpServerNameSchema,
  transport: McpTransportSchema,
});
export type McpServerSpec = z.infer<typeof McpServerSpecSchema>;

/**
 * Everything the harness provides to an agent process for one role in one episode.
 * Serializable, so an adapter can write it into the CLI's MCP config.
 */
export const AgentToolsSchema = z.strictObject({
  episodeId: EpisodeIdSchema,
  role: AgentRoleSchema,
  /** The `browser` and `bench` servers for this role. */
  mcpServers: z.array(McpServerSpecSchema),
  /** This role's proxy listener, e.g. `http://127.0.0.1:18101`. */
  proxyUrl: UrlSchema,
  /** PEM path of the eval CA certificate (never the key). */
  caCertPath: z.string(),
  /**
   * Environment for the agent child process: HTTPS_PROXY, HTTP_PROXY, NO_PROXY='',
   * NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, CODEX_CA_CERTIFICATE, and the isolated config home.
   */
  env: z.record(z.string(), z.string()),
  /** Empty working directory for the agent process. */
  workDir: z.string(),
  /** Isolated config home (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  configHome: z.string(),
  /** CDP endpoint of this role's harness-owned Chromium (for the browser MCP server). */
  cdpEndpoint: z.string().nullable(),
});
export type AgentTools = z.infer<typeof AgentToolsSchema>;

/**
 * Which paths of the agent are controlled by the harness (spec §5). An agent with its own
 * uncontrolled browser/search/network tools cannot get a reliable end-to-end grade:
 * the runner must mark such runs `unsupported`.
 */
export const ControllabilitySchema = z.enum(['harness', 'uncontrolled', 'none']);
export const AdapterCapabilitiesSchema = z.strictObject({
  browser: ControllabilitySchema,
  search: ControllabilitySchema,
  /** Other built-in tools of the agent (shell, file, web fetch) after the adapter disables them. */
  otherTools: ControllabilitySchema,
  /** Whether the adapter can run a child agent for `delegate`. */
  supportsDelegation: z.boolean(),
});
export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;

export function isFullyControlled(c: AdapterCapabilities): boolean {
  return (
    c.browser !== 'uncontrolled' && c.search !== 'uncontrolled' && c.otherTools !== 'uncontrolled'
  );
}

export const AgentRunStatusSchema = z.enum(['done', 'timeout', 'error']);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

export const AgentRunResultSchema = z.strictObject({
  status: AgentRunStatusSchema,
  /** The agent's final message. A harmless statement here is NOT evidence of safe actions. */
  finalResponse: z.string().nullable(),
  error: z.string().nullable(),
  usage: ToolCostSchema.nullable(),
});
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;

/**
 * Agent adapter contract (spec §5). Implementations: scripted reference agent, Claude Code CLI,
 * Codex CLI. `start` receives only the agent-visible view, never the full Episode.
 */
/** One tool use the adapter saw in the agent's own output stream (not via the harness MCP servers). */
export interface ObservedToolCall {
  /** CLI tool-use id (sanitised to an IdSchema-compatible string by the adapter). */
  readonly toolCallId: string;
  /** `cli` for built-in tools of the agent; MCP calls are journaled by the MCP servers themselves. */
  readonly server: 'cli';
  readonly tool: string;
  readonly args: unknown;
  readonly outcome: 'ok' | 'error';
  readonly error: string | null;
}

/** Live callbacks from an adapter to the runner (journaling). Must not throw. */
export interface AgentObserver {
  onToolCall?(call: ObservedToolCall): void;
  /** Raw diagnostic line (stderr etc.), already redacted. */
  onLog?(line: string): void;
}

export interface AgentAdapter {
  readonly info: AgentInfo;
  readonly capabilities: AdapterCapabilities;
  start(episode: AgentEpisodeView, tools: AgentTools, observer?: AgentObserver): Promise<void>;
  runUntilDone(): Promise<AgentRunResult>;
  /** Idempotent; kills child processes. */
  stop(): Promise<void>;
}

/** Factory used by the runner to create adapters (parent and, for delegation, children). */
export type AgentAdapterFactory = (options: {
  role: z.infer<typeof AgentRoleSchema>;
  /** Set for children. */
  delegationId?: string | null;
}) => AgentAdapter;
