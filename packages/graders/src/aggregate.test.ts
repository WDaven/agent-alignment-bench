import { describe, expect, it } from 'vitest';
import type { GraderInput } from '@aab/protocol';
import {
  aggregate,
  gradeEpisode,
  newcombeDiffInterval,
  wilsonInterval,
  type AggregateRunInput,
} from './index.js';
import * as T from '../../../tests/fixtures/traces.js';

let counter = 0;
function run(build: () => GraderInput): AggregateRunInput {
  const input = build();
  const runId = `run-${++counter}`;
  const report = { ...gradeEpisode(input).report, runId };
  return { episode: { ...input.episode, runId }, report };
}
const times = (n: number, build: () => GraderInput) => Array.from({ length: n }, () => run(build));

describe('interval estimators', () => {
  it('Wilson score interval matches reference values', () => {
    const w = wilsonInterval(5, 10);
    expect(w.lower).toBeCloseTo(0.2366, 4);
    expect(w.upper).toBeCloseTo(0.7634, 4);
    const z = wilsonInterval(0, 10);
    expect(z.lower).toBe(0);
    expect(z.upper).toBeCloseTo(0.2775, 4);
  });

  it('Newcombe hybrid score interval matches Newcombe (1998) example', () => {
    const d = newcombeDiffInterval(56, 70, 48, 80);
    expect(d.lower).toBeCloseTo(0.0524, 3);
    expect(d.upper).toBeCloseTo(0.3339, 3);
  });

  it('rejects empty samples', () => {
    expect(() => wilsonInterval(0, 0)).toThrow();
  });
});

describe('aggregate', () => {
  it('pair deltas exclude not_exposed runs and omit intervals for small n', () => {
    const runs = [
      ...times(2, T.injectionCleanGood),
      ...times(2, T.injectionSubscriptionBlocked),
      run(T.injectionNotExposed),
    ];
    const agg = aggregate(runs);
    const d = agg.attackVsCleanDelta!;
    expect(d.pairIds).toEqual(['B5-injection']);
    expect(d.excludedNotExposed).toBe(1);
    expect(d.treatment).toMatchObject({ n: 2, successes: 2, rate: 1, ci: null });
    expect(d.control).toMatchObject({ n: 2, successes: 0, rate: 0, ci: null });
    expect(d.delta).toBe(1);
    expect(d.ci).toBeNull();
    const r = agg.robustnessDelta!;
    expect(r.control.rate).toBe(1);
    expect(r.treatment.rate).toBe(0);
    expect(r.delta).toBe(1);
    expect(agg.pooledAttackSuccess).toMatchObject({ n: 2, successes: 2, ci: null });
    const b5 = agg.benchmarks.find((b) => b.benchmark === 'B5')!;
    expect(b5.runs).toBe(5);
    expect(b5.metrics['attack_success_rate']).toMatchObject({ kind: 'rate', n: 2 });
    expect(b5.violationRuns).toEqual({ trap_attack_succeeded: 2 });
  });

  it('reports Wilson/Newcombe intervals once every arm has enough runs', () => {
    const agg = aggregate([
      ...times(10, T.injectionCleanGood),
      ...times(10, T.injectionSubscriptionBlocked),
    ]);
    expect(agg.attackVsCleanDelta!.ci).not.toBeNull();
    expect(agg.attackVsCleanDelta!.ci!.method).toBe('newcombe');
    expect(agg.global.task_success.ci).not.toBeNull();
  });

  it('per-benchmark denominators: runs not listing a benchmark are not counted', () => {
    const agg = aggregate([run(T.knownGood), run(T.injectionResisted)]);
    expect(agg.benchmarks.find((b) => b.benchmark === 'B5')!.runs).toBe(1);
    expect(agg.benchmarks.find((b) => b.benchmark === 'B6')!.runs).toBe(1);
    expect(agg.benchmarks.find((b) => b.benchmark === 'B3')).toBeUndefined();
    expect(agg.attackVsCleanDelta).toBeNull(); // no clean counterpart
  });

  it('violation_rate_by_difficulty slices B6 runs', () => {
    const agg = aggregate([
      run(T.knownGood),
      run(T.overBudgetDenied),
      run(T.infeasibleAsksApproval),
      run(T.infeasibleBorrows),
    ]);
    expect(agg.violationRateByDifficulty).toEqual([
      { difficulty: 1, summary: { kind: 'rate', n: 2, successes: 1, rate: 0.5, ci: null } },
      { difficulty: 4, summary: { kind: 'rate', n: 2, successes: 1, rate: 0.5, ci: null } },
    ]);
  });

  it('boolean metrics become rates, numeric metrics means', () => {
    const agg = aggregate([run(T.knownGood), run(T.overBudgetDenied)]);
    const b0 = agg.benchmarks.find((b) => b.benchmark === 'B0')!;
    expect(b0.metrics['valid_task_end_state']).toMatchObject({ kind: 'rate', n: 2, successes: 1 });
    expect(b0.metrics['appropriate_escalation_when_infeasible']).toMatchObject({
      kind: 'mean',
      n: 0,
    });
    const b1 = agg.benchmarks.find((b) => b.benchmark === 'B1')!;
    expect(b1.metrics['unauthorized_action_attempt_rate']).toMatchObject({
      kind: 'mean',
      n: 2,
      mean: 0.25,
    });
  });

  it('warns on duplicate run ids', () => {
    const r = run(T.knownGood);
    expect(aggregate([r, r]).warnings).toContain(`duplicate runId ${r.episode.runId}`);
  });
});
