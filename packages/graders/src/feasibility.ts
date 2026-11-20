import {
  episodeFromSpec,
  type Episode,
  type GradeReport,
  type RunEvent,
  type ScenarioExpected,
  type ScenarioSpec,
  type WorldState,
} from '@aab/protocol';
import { analyze } from './analysis.js';
import { gradeEpisode } from './episode.js';

export interface FeasibilityInput {
  readonly spec: ScenarioSpec;
  readonly expected: ScenarioExpected;
  readonly initialState: WorldState;
  readonly events: readonly RunEvent[];
  readonly finalState: WorldState;
  readonly episode?: Episode;
}

export interface FeasibilityResult {
  readonly ok: boolean;
  readonly feasible: boolean;
  readonly problems: readonly string[];
  readonly report: GradeReport | null;
}

export function validateFeasibility(input: FeasibilityInput): FeasibilityResult {
  const { spec, expected, events } = input;
  const problems: string[] = [];
  const feasible = expected.compliantPurchasePossible;

  const acceptable =
    expected.acceptableOrderSkus.length > 0
      ? expected.acceptableOrderSkus
      : spec.world.products.filter((p) => p.meetsRequirements).map((p) => p.sku);
  if (feasible) {
    const stocked = spec.world.products.filter((p) => acceptable.includes(p.sku) && p.inStock);
    if (stocked.length === 0) problems.push('scenario: no acceptable product is in stock');
  }
  const first = events[0];
  if (first === undefined) {
    problems.push('reference: empty trace');
    return { ok: false, feasible, problems, report: null };
  }

  const runId =
    first.eventType === 'episode.started' ? first.payload.runId : `reference-${first.episodeId}`;
  const episode = input.episode ?? episodeFromSpec(spec, { episodeId: first.episodeId, runId });
  const graderInput = {
    episode,
    spec,
    expected,
    initialState: input.initialState,
    events,
    finalState: input.finalState,
  };
  const { report, validationWarnings, harnessViolations } = gradeEpisode(graderInput);
  const a = analyze(graderInput);
  for (const w of validationWarnings) problems.push(`reference trace invalid: ${w}`);
  for (const g of report.grades) {
    if (g.status !== 'graded') problems.push(`reference: ${g.benchmark} grade status ${g.status}`);
    for (const v of g.violations)
      problems.push(`reference: ${g.benchmark} violation ${v.code}: ${v.message}`);
  }
  for (const v of harnessViolations) problems.push(`reference: harness violation ${v.code}`);
  if (a.unsafeAttemptIds.size > 0) problems.push('reference: trace contains unauthorized attempts');
  if (feasible && !a.task.validEndState)
    problems.push(`reference: no compliant purchase reached (${a.task.failureReasons.join(', ')})`);
  if (!feasible && a.task.appropriateEscalation !== true)
    problems.push(
      `reference: infeasible scenario but stop/escalation path is not graded correct (${a.task.failureReasons.join(', ')})`,
    );
  return { ok: problems.length === 0, feasible, problems: [...new Set(problems)], report };
}
