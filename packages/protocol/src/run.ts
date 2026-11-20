import { z } from 'zod';
import {
  EpisodeIdSchema,
  IdSchema,
  IsoTimestampSchema,
  RunIdSchema,
  ScenarioIdSchema,
} from './common.js';

export const IsolationSchema = z.enum(['container', 'proxy-only']);
export type Isolation = z.infer<typeof IsolationSchema>;

export const AgentKindSchema = z.enum(['scripted', 'claude_code', 'codex', 'external']);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const ToolCostSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  cacheWriteTokens: z.number().int().nonnegative().nullable(),
  turns: z.number().int().nonnegative().nullable(),
  costMicroUsd: z.number().int().nonnegative().nullable(),
  toolCalls: z.number().int().nonnegative(),
  worldActions: z.number().int().nonnegative(),
});
export type ToolCost = z.infer<typeof ToolCostSchema>;

export const AgentInfoSchema = z.strictObject({
  agentId: IdSchema,
  kind: AgentKindSchema,
  model: z.string().nullable(),
  modelVersion: z.string().nullable(),
  cliVersion: z.string().nullable(),
  promptVersion: z.string(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

export const RunMetadataSchema = z.strictObject({
  runId: RunIdSchema,
  episodeId: EpisodeIdSchema,
  scenarioId: ScenarioIdSchema,
  agent: AgentInfoSchema,
  seed: z.number().int().nonnegative(),
  fixtureVersion: z.string(),
  envBuildHash: z.string(),
  graderVersion: z.string(),
  protocolVersion: z.string(),
  isolation: IsolationSchema,
  repetition: z.number().int().nonnegative(),
  suite: z.string().nullable(),
  startedAt: IsoTimestampSchema,
  endedAt: IsoTimestampSchema.nullable(),
  toolCost: ToolCostSchema.nullable(),
  authMode: z.enum(['api_key', 'inherit', 'none']),
  endReason: z
    .enum(['final_response', 'max_steps', 'timeout', 'agent_error', 'harness_error', 'aborted'])
    .nullable(),
  support: z.enum(['supported', 'unsupported']),
  environment: z.strictObject({
    node: z.string(),
    platform: z.string(),
    arch: z.string(),
    chromium: z.string().nullable(),
    gitCommit: z.string().nullable(),
    nondeterministicFields: z.array(z.string()),
  }),
});
export type RunMetadata = z.infer<typeof RunMetadataSchema>;
