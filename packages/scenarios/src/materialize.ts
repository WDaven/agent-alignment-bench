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
  /** Secret of this run; role tokens are derived from it (never from the seed). >= 16 chars. */
  runSecret: string;
  /** Override the generated run id (e.g. the runner's run directory name). */
  runId?: string;
  /** Override the generated episode id (needed when running repetitions of the same seed in parallel). */
  episodeId?: string;
}

/**
 * Everything the WORLD needs to run one episode. Built only from a `ScenarioSpec`; there is no
 * input path for the hidden `expected` answer key, and the spec is re-validated with the strict
 * `ScenarioSpecSchema`, which rejects unknown keys such as `expected`.
 */
export interface MaterializedEpisode {
  /** Spec with `seed` set to the effective seed. */
  readonly spec: ScenarioSpec;
  readonly episode: Episode;
  /** Initial world fixture (site-facing view; `traps` = all traps of the scenario). */
  readonly fixture: MaterializedFixture;
  /** Bearer tokens for the Agent API, one per agent role (delegation tokens are derived later). */
  readonly tokens: Readonly<Record<AgentRole, string>>;
  /** What each agent role is told (parent: the user task). */
  readonly agentViews: Readonly<Record<AgentRole, AgentEpisodeView>>;
}

function keyedHex(runSecret: string, label: string, n = 16): string {
  return createHmac('sha256', runSecret).update(label).digest('hex').slice(0, n);
}

/**
 * Deterministic but OPAQUE run id: keyed by the run secret, so an agent that sees it cannot
 * recover the scenario id or seed by hashing candidates.
 */
export function runIdFor(runSecret: string, scenarioId: string, seed: number): string {
  return `run-${keyedHex(runSecret, `aab-run\u0000${scenarioId}\u0000${seed}`)}`;
}

/**
 * Deterministic, opaque episode id (agents see it, e.g. on the probe page and in their episode
 * view, so it must not reveal scenario id, variant or seed).
 */
export function episodeIdFor(
  runSecret: string,
  runId: string,
  scenarioId: string,
  seed: number,
): string {
  return `ep-${keyedHex(runSecret, `aab-episode\u0000${runId}\u0000${scenarioId}\u0000${seed}`)}`;
}

/** Deterministic seed for one site plugin in one episode (SiteContext.seedFor). */
export function siteSeedFor(seed: number, pluginId: string): number {
  return deriveSeed(seed, `site:${pluginId}`);
}

/**
 * Materialise a scenario into an initial world fixture + Episode for `seed` (defaults to the
 * scenario's seed). Pure and deterministic: no clock, no Math.random. Tokens depend only on
 * `runSecret`, episode id and role.
 */
export function materialize(
  scenario: ScenarioSpec,
  seed: number = scenario.seed,
  opts: MaterializeOptions,
): MaterializedEpisode {
  // Strict re-validation: an object carrying `expected` (or anything else extra) is rejected here.
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
