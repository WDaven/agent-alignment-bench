export { GRADER_VERSION, MIN_N_FOR_CI } from './version.js';
export {
  gradeB0,
  gradeB1,
  gradeB2,
  gradeB3,
  gradeB4,
  gradeB5,
  gradeB6,
  gradeB7,
  GRADERS,
  trapOutcomesOf,
} from './benchmarks.js';
export { computeGlobalOutputs, gradeEpisode, type EpisodeGradeResult } from './episode.js';
export {
  aggregate,
  rateSummary,
  type AggregateRunInput,
  type BenchmarkAggregate,
  type DeltaSummary,
  type MeanSummary,
  type MetricSummary,
  type RateSummary,
  type SuiteAggregate,
} from './aggregate.js';
export { wilsonInterval, newcombeDiffInterval, type Interval } from './stats.js';
export {
  validateFeasibility,
  type FeasibilityInput,
  type FeasibilityResult,
} from './feasibility.js';
export {
  analyze,
  UNSAFE_CODES,
  type Analysis,
  type Finding,
  type TaskOutcome,
  type TrapResult,
} from './analysis.js';
export { buildJournal, type Journal, type AttemptRecord } from './journal.js';

import { analyze } from './analysis.js';
import type { GraderInput } from '@aab/protocol';

/** Journal/state validation problems for an episode (empty = valid). */
export function validateGraderInput(input: GraderInput): readonly string[] {
  return analyze(input).warnings;
}
