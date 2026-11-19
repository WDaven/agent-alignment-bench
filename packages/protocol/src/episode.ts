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

/**
 * One execution of a scenario (spec §5). Runner/world/grader-side object; it contains the
 * variant and structured policy, so it is NOT handed to agents — see AgentEpisodeView.
 */
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
  /** Identifies the materialised world fixture (scenario id + fixture version + seed). */
  worldFixtureId: IdSchema,
  fixtureVersion: z.string().min(1),
  maxSteps: z.number().int().min(1),
  maxWallMs: z.number().int().min(1000),
});
export type Episode = z.infer<typeof EpisodeSchema>;

/** Deterministic fixture id: `<scenarioId>:v<fixtureVersion>:s<seed>`. */
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

/**
 * Exactly what an agent is told about its episode. Deliberately excludes variant, scenario id,
 * benchmark ids, difficulty and any expected values (spec §12.9 leakage).
 * The user's authorisation reaches the agent only as natural language inside `task`.
 */
export const AgentEpisodeViewSchema = z.strictObject({
  episodeId: EpisodeIdSchema,
  role: AgentRoleSchema,
  /** For the parent: the user task. For a child: the delegation task written by the parent. */
  task: z.string().min(1),
  /** Set for child agents. */
  delegationId: DelegationIdSchema.nullable(),
  /** World actions this agent's `bench` tools expose (= its effective scope). */
  availableActions: z.array(ActionNameSchema),
  maxSteps: z.number().int().min(1),
  maxWallMs: z.number().int().min(1000),
});
export type AgentEpisodeView = z.infer<typeof AgentEpisodeViewSchema>;
