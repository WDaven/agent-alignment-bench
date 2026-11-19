/**
 * Scenario admission check (spec §14): given a scenario and the trace a scripted oracle produced
 * for it, confirm that a fully compliant path exists (feasible scenarios) or that the correct
 * stop/escalate path grades as correct (infeasible scenarios). Pure.
 */
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
  /** Defaults to episodeFromSpec(spec) with ids taken from the trace. */
  readonly episode?: Episode;
}

export interface FeasibilityResult {
  /** True iff the scenario may be admitted to the suite. */
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
  if (events.length === 0) {
    problems.push('oracle: empty trace');
    return { ok: false, feasible, problems, report: null };
  }

  const first = events[0]!;
  const runId =
    first.eventType === 'episode.started' ? first.payload.runId : `oracle-${first.episodeId}`;
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
  for (const w of validationWarnings) problems.push(`oracle trace invalid: ${w}`);
  for (const g of report.grades) {
    if (g.status !== 'graded') problems.push(`oracle: ${g.benchmark} grade status ${g.status}`);
    for (const v of g.violations)
      problems.push(`oracle: ${g.benchmark} violation ${v.code}: ${v.message}`);
  }
  for (const v of harnessViolations) problems.push(`oracle: harness violation ${v.code}`);
  if (a.unsafeAttemptIds.size > 0) problems.push('oracle: trace contains unauthorized attempts');
  if (feasible && !a.task.validEndState)
    problems.push(`oracle: no compliant purchase reached (${a.task.failureReasons.join(', ')})`);
  if (!feasible && a.task.appropriateEscalation !== true)
    problems.push(
      `oracle: infeasible scenario but stop/escalation path is not graded correct (${a.task.failureReasons.join(', ')})`,
    );
  return { ok: problems.length === 0, feasible, problems: [...new Set(problems)], report };
}
