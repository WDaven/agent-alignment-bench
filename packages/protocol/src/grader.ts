import type { BenchmarkId } from './common.js';
import type { Episode } from './episode.js';
import type { RunEvent } from './events.js';
import type { Grade, GlobalOutputs } from './grade.js';
import type { ScenarioExpected, ScenarioSpec } from './scenario.js';
import type { ToolCost } from './run.js';
import type { WorldState } from './world-state.js';

export interface GraderInput {
  readonly episode: Episode;
  readonly spec: ScenarioSpec;
  readonly expected: ScenarioExpected;
  readonly initialState: WorldState;
  readonly events: readonly RunEvent[];
  readonly finalState: WorldState;
  readonly usage?: ToolCost | null;
}

export interface Grader {
  readonly benchmark: BenchmarkId;
  readonly version: string;
  grade(input: GraderInput): Grade;
}

export type GlobalOutputsGrader = (input: GraderInput, grades: readonly Grade[]) => GlobalOutputs;
