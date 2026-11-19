import { z } from 'zod';
import {
  EpisodeIdSchema,
  IdSchema,
  IsoTimestampSchema,
  RunIdSchema,
  ScenarioIdSchema,
} from './common.js';

/**
 * `container`: agent + browser on an internal network whose only egress is the proxy (a real boundary).
 * `proxy-only`: local dev run; proxy settings are NOT a security boundary. Reports must label it.
 */
export const IsolationSchema = z.enum(['container', 'proxy-only']);
export type Isolation = z.infer<typeof IsolationSchema>;

export const AgentKindSchema = z.enum(['scripted', 'claude_code', 'codex', 'external']);
export type AgentKind = z.infer<typeof AgentKindSchema>;

/** Optional cost accounting. Unknown values are null, never 0. */
export const ToolCostSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  cacheReadTokens: z.number().int().nonnegative().nullable(),
  /** Reported model cost in micro-USD (1e-6 USD), if the CLI reports it. */
  costMicroUsd: z.number().int().nonnegative().nullable(),
  toolCalls: z.number().int().nonnegative(),
  worldActions: z.number().int().nonnegative(),
});
export type ToolCost = z.infer<typeof ToolCostSchema>;

/** Identity of the agent under test. */
export const AgentInfoSchema = z.strictObject({
  /** Stable adapter id, e.g. `scripted`, `claude-code`, `codex`. */
  agentId: IdSchema,
  kind: AgentKindSchema,
  /** Model name as configured, e.g. `claude-opus-4-1`. null for scripted agents. */
  model: z.string().nullable(),
  /** Model/CLI version string as reported by the tool. */
  modelVersion: z.string().nullable(),
  cliVersion: z.string().nullable(),
  /** Version of the harness system prompt / task framing given to the agent. */
  promptVersion: z.string(),
});
export type AgentInfo = z.infer<typeof AgentInfoSchema>;

/** `runs/<runId>/meta.json` (spec §10). */
export const RunMetadataSchema = z.strictObject({
  runId: RunIdSchema,
  episodeId: EpisodeIdSchema,
  scenarioId: ScenarioIdSchema,
  agent: AgentInfoSchema,
  seed: z.number().int().nonnegative(),
  fixtureVersion: z.string(),
  /** Hash identifying the harness build (e.g. git commit + lockfile hash). */
  envBuildHash: z.string(),
  graderVersion: z.string(),
  protocolVersion: z.string(),
  isolation: IsolationSchema,
  /** Repetition index within a suite run (0-based). */
  repetition: z.number().int().nonnegative(),
  suite: z.string().nullable(),
  startedAt: IsoTimestampSchema,
  endedAt: IsoTimestampSchema.nullable(),
  toolCost: ToolCostSchema.nullable(),
});
export type RunMetadata = z.infer<typeof RunMetadataSchema>;
