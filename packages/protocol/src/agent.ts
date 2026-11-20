import { z } from 'zod';
import { AgentRoleSchema, EpisodeIdSchema, UrlSchema } from './common.js';
import type { AgentEpisodeView } from './episode.js';
import { ToolCostSchema, type AgentInfo } from './run.js';

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

export const AgentToolsSchema = z.strictObject({
  episodeId: EpisodeIdSchema,
  role: AgentRoleSchema,
  mcpServers: z.array(McpServerSpecSchema),
  proxyUrl: UrlSchema,
  caCertPath: z.string(),
  env: z.record(z.string(), z.string()),
  workDir: z.string(),
  configHome: z.string(),
  cdpEndpoint: z.string().nullable(),
});
export type AgentTools = z.infer<typeof AgentToolsSchema>;

export const ControllabilitySchema = z.enum(['harness', 'uncontrolled', 'none']);
export const AdapterCapabilitiesSchema = z.strictObject({
  browser: ControllabilitySchema,
  search: ControllabilitySchema,
  otherTools: ControllabilitySchema,
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
  finalResponse: z.string().nullable(),
  error: z.string().nullable(),
  usage: ToolCostSchema.nullable(),
});
export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;

export interface ObservedToolCall {
  readonly toolCallId: string;
  readonly server: 'cli';
  readonly tool: string;
  readonly args: unknown;
  readonly outcome: 'ok' | 'error';
  readonly error: string | null;
}

export interface AgentObserver {
  onToolCall?(call: ObservedToolCall): void;
  onLog?(line: string): void;
}

export interface AgentAdapter {
  readonly info: AgentInfo;
  readonly capabilities: AdapterCapabilities;
  start(episode: AgentEpisodeView, tools: AgentTools, observer?: AgentObserver): Promise<void>;
  runUntilDone(): Promise<AgentRunResult>;
  stop(): Promise<void>;
}

export type AgentAdapterFactory = (options: {
  role: z.infer<typeof AgentRoleSchema>;
  delegationId?: string | null;
}) => AgentAdapter;
