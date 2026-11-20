import { z } from 'zod';
import {
  AgentRoleSchema,
  BenchmarkIdSchema,
  DelegationIdSchema,
  EpisodeIdSchema,
  IdSchema,
  RunIdSchema,
  ScenarioIdSchema,
  VariantSchema,
} from './common.js';
import { ActionNameSchema } from './actions.js';
import { AuthorizationPolicySchema } from './policy.js';
import { DifficultySchema, type ScenarioSpec } from './scenario.js';

export const EpisodeSchema = z.strictObject({
  id: EpisodeIdSchema,
  runId: RunIdSchema,
  scenarioId: ScenarioIdSchema,
  pairId: IdSchema,
  variant: VariantSchema,
  seed: z.number().int().nonnegative(),
  benchmarkIds: z.array(BenchmarkIdSchema).min(1),
  difficulty: DifficultySchema,
  userTask: z.string().min(1),
  authorization: AuthorizationPolicySchema,
  worldFixtureId: IdSchema,
  fixtureVersion: z.string().min(1),
  maxSteps: z.number().int().min(1),
  maxWallMs: z.number().int().min(1000),
});
export type Episode = z.infer<typeof EpisodeSchema>;

export function worldFixtureIdFor(
  spec: Pick<ScenarioSpec, 'id' | 'fixtureVersion' | 'seed'>,
): string {
  return `${spec.id}:v${spec.fixtureVersion}:s${spec.seed}`;
}

export function episodeFromSpec(
  spec: ScenarioSpec,
  ids: { episodeId: string; runId: string },
): Episode {
  return {
    id: ids.episodeId,
    runId: ids.runId,
    scenarioId: spec.id,
    pairId: spec.pairId,
    variant: spec.variant,
    seed: spec.seed,
    benchmarkIds: spec.benchmarkIds,
    difficulty: spec.difficulty,
    userTask: spec.userTask,
    authorization: spec.authorization,
    worldFixtureId: worldFixtureIdFor(spec),
    fixtureVersion: spec.fixtureVersion,
    maxSteps: spec.maxSteps,
    maxWallMs: spec.maxWallMs,
  };
}

export const AgentEpisodeViewSchema = z.strictObject({
  episodeId: EpisodeIdSchema,
  role: AgentRoleSchema,
  task: z.string().min(1),
  delegationId: DelegationIdSchema.nullable(),
  availableActions: z.array(ActionNameSchema),
  maxSteps: z.number().int().min(1),
  maxWallMs: z.number().int().min(1000),
});
export type AgentEpisodeView = z.infer<typeof AgentEpisodeViewSchema>;
