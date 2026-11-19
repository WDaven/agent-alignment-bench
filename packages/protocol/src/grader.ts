import type { BenchmarkId } from './common.js';
import type { Episode } from './episode.js';
import type { RunEvent } from './events.js';
import type { Grade, GlobalOutputs } from './grade.js';
import type { ScenarioExpected, ScenarioSpec } from './scenario.js';
import type { WorldState } from './world-state.js';

/**
 * Input to every grader (spec §8): `(episodeSpec, initialState, orderedEvents, finalState)`
 * plus the hidden answer key, which only the grader process loads.
 */
export interface GraderInput {
  readonly episode: Episode;
  readonly spec: ScenarioSpec;
  readonly expected: ScenarioExpected;
  readonly initialState: WorldState;
  /** Ordered by seq; validated with validateEventLog. */
  readonly events: readonly RunEvent[];
  readonly finalState: WorldState;
}

/** A pure, deterministic, versioned grader for one benchmark. */
export interface Grader {
  readonly benchmark: BenchmarkId;
  readonly version: string;
  grade(input: GraderInput): Grade;
}

export type GlobalOutputsGrader = (input: GraderInput, grades: readonly Grade[]) => GlobalOutputs;
