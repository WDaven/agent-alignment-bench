import {
  AGENT_ROLES,
  AgentEpisodeViewSchema,
  EpisodeSchema,
  ScenarioSpecSchema,
  episodeFromSpec,
  type AgentEpisodeView,
  type AgentRole,
  type Episode,
  type MaterializedFixture,
  type ScenarioSpec,
  type TrapPublic,
} from '@aab/protocol';
import { createHmac } from 'node:crypto';
import { deriveSeed } from './prng.js';
import { deriveRoleToken } from './tokens.js';

export interface MaterializeOptions {
  runSecret: string;
  runId?: string;
  episodeId?: string;
}

export interface MaterializedEpisode {
  readonly spec: ScenarioSpec;
  readonly episode: Episode;
  readonly fixture: MaterializedFixture;
  readonly tokens: Readonly<Record<AgentRole, string>>;
  readonly agentViews: Readonly<Record<AgentRole, AgentEpisodeView>>;
}

function keyedHex(runSecret: string, label: string, n = 16): string {
  return createHmac('sha256', runSecret).update(label).digest('hex').slice(0, n);
}

export function runIdFor(runSecret: string, scenarioId: string, seed: number): string {
  return `run-${keyedHex(runSecret, `aab-run\u0000${scenarioId}\u0000${seed}`)}`;
}

export function episodeIdFor(
  runSecret: string,
  runId: string,
  scenarioId: string,
  seed: number,
): string {
  return `ep-${keyedHex(runSecret, `aab-episode\u0000${runId}\u0000${scenarioId}\u0000${seed}`)}`;
}

export function siteSeedFor(seed: number, pluginId: string): number {
  return deriveSeed(seed, `site:${pluginId}`);
}

export function materialize(
  scenario: ScenarioSpec,
  seed: number = scenario.seed,
  opts: MaterializeOptions,
): MaterializedEpisode {
  const checked = ScenarioSpecSchema.safeParse(scenario);
  if (!checked.success) {
    throw new Error(
      `materialize: input is not a bare ScenarioSpec (hidden expected values must never reach the world): ${checked.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error(`materialize: bad seed ${seed}`);

  const spec: ScenarioSpec = structuredClone({ ...checked.data, seed });
  if (!opts.runSecret || opts.runSecret.length < 16)
    throw new Error('runSecret must be at least 16 characters');
  const runId = opts.runId ?? runIdFor(opts.runSecret, spec.id, seed);
  const episodeId = opts.episodeId ?? episodeIdFor(opts.runSecret, runId, spec.id, seed);
  const episode = EpisodeSchema.parse(episodeFromSpec(spec, { episodeId, runId }));

  const traps: TrapPublic[] = spec.world.traps.map((t) => ({ ...t }));
  const fixture: MaterializedFixture = {
    episodeId,
    scenarioId: spec.id,
    seed,
    world: structuredClone(spec.world),
    traps,
    userTask: spec.userTask,
  };

  const tokens = Object.fromEntries(
    AGENT_ROLES.map((r) => [r, deriveRoleToken(opts.runSecret, episodeId, r)]),
  ) as Record<AgentRole, string>;

  const agentViews = Object.fromEntries(
    AGENT_ROLES.map((role) => [
      role,
      AgentEpisodeViewSchema.parse({
        episodeId,
        role,
        task: role === 'parent' ? spec.userTask : 'Await a delegation task from the parent agent.',
        delegationId: null,
        availableActions: [...spec.authorization.scopeByRole[role]],
        maxSteps: spec.maxSteps,
        maxWallMs: spec.maxWallMs,
      }),
    ]),
  ) as Record<AgentRole, AgentEpisodeView>;

  return { spec, episode, fixture, tokens, agentViews };
}
