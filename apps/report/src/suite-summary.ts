/**
 * Small suite summary over `aggregate(runs)` from @aab/graders. The aggregate is passed in as
 * data (this app depends only on @aab/protocol); the types below are a structural subset of
 * graders' SuiteAggregate, so its value is accepted directly.
 */
import { BENCHMARK_TITLES, type BenchmarkId } from '@aab/protocol';
import { esc, fmtMetric, page, table } from './html.js';

export interface IntervalLike {
  readonly lower: number;
  readonly upper: number;
  readonly level: number;
}
export interface RateLike {
  readonly kind: 'rate';
  readonly n: number;
  readonly successes: number;
  readonly rate: number | null;
  readonly ci: IntervalLike | null;
}
export interface MeanLike {
  readonly kind: 'mean';
  readonly n: number;
  readonly mean: number | null;
  readonly min: number | null;
  readonly max: number | null;
}
export interface DeltaLike {
  readonly definition: string;
  readonly treatment: RateLike;
  readonly control: RateLike;
  readonly delta: number | null;
  readonly ci: IntervalLike | null;
  readonly pairIds: readonly string[];
  readonly excludedNotExposed: number;
}
export interface SuiteAggregateLike {
  readonly graderVersion: string;
  readonly minNForCi: number;
  readonly totalRuns: number;
  readonly benchmarks: readonly {
    readonly benchmark: BenchmarkId;
    readonly runs: number;
    readonly graded: number;
    readonly metrics: Readonly<Record<string, RateLike | MeanLike>>;
    readonly violationRuns: Readonly<Record<string, number>>;
  }[];
  readonly attackVsCleanDelta: DeltaLike | null;
  readonly robustnessDelta: DeltaLike | null;
  readonly violationRateByDifficulty: readonly { difficulty: number; summary: RateLike }[];
  readonly pooledAttackSuccess: RateLike;
  readonly global: Readonly<Record<string, RateLike>>;
  readonly warnings: readonly string[];
}

export interface SuiteRunRow {
  readonly runId: string;
  readonly scenarioId: string;
  readonly variant: string;
  readonly taskSuccess: boolean;
  readonly policyCompliance: boolean;
  /** Relative link to the run's report.html, if any. */
  readonly reportHref?: string;
}

export interface SuiteSummaryInput {
  readonly title?: string;
  readonly aggregate: SuiteAggregateLike;
  readonly runs: readonly SuiteRunRow[];
}

function ci(i: IntervalLike | null, n: number, minN: number): string {
  return i
    ? `[${i.lower.toFixed(3)}, ${i.upper.toFixed(3)}]`
    : `<span class="muted">no CI (n=${n} &lt; ${minN})</span>`;
}

function summaryCell(s: RateLike | MeanLike, minN: number): string[] {
  if (s.kind === 'rate') return [fmtMetric(s.rate), `${s.successes}/${s.n}`, ci(s.ci, s.n, minN)];
  return [
    fmtMetric(s.mean),
    `n=${s.n}`,
    s.n > 0 ? `mean of per-episode values; range ${fmtMetric(s.min)}–${fmtMetric(s.max)}` : '',
  ];
}

function deltaBlock(name: string, d: DeltaLike | null, minN: number): string {
  if (!d)
    return `<p><b>${esc(name)}</b>: <span class="muted">null (no pair with both a clean and an exposed adversarial run)</span></p>`;
  return `<p><b>${esc(name)}</b> = ${fmtMetric(d.delta)} ${d.ci ? `95% CI [${d.ci.lower.toFixed(3)}, ${d.ci.upper.toFixed(3)}]` : `<span class="muted">(no CI: n=${d.treatment.n}/${d.control.n}, need ${minN} per arm)</span>`}<br>
<span class="muted">${esc(d.definition)}; treatment ${d.treatment.successes}/${d.treatment.n}, control ${d.control.successes}/${d.control.n}; pairs ${esc(d.pairIds.join(', '))}; not_exposed excluded: ${d.excludedNotExposed}</span></p>`;
}

export function renderSuiteSummary(input: SuiteSummaryInput): string {
  const a = input.aggregate;
  const minN = a.minNForCi;
  const title = input.title ?? 'Suite summary';
  const parts: string[] = [
    `<h1>${esc(title)}</h1>`,
    `<p>${a.totalRuns} runs, grader ${esc(a.graderVersion)}. Rates are reported with their denominators; confidence intervals only when n ≥ ${minN}.</p>`,
  ];
  if (a.warnings.length > 0)
    parts.push(`<ul class="warn">${a.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`);

  parts.push('<h2>Global</h2>');
  parts.push(
    table(
      ['output', 'rate', 'k/n', '95% CI'],
      Object.entries(a.global).map(([k, s]) => [esc(k), ...summaryCell(s, minN)]),
    ),
  );

  parts.push('<h2>Paired and cross-episode metrics</h2>');
  parts.push(deltaBlock('B5 attack_vs_clean_delta', a.attackVsCleanDelta, minN));
  parts.push(deltaBlock('B7 robustness_delta', a.robustnessDelta, minN));
  parts.push(
    `<p><b>B5 pooled attack success (exposed traps only)</b>: ${summaryCell(a.pooledAttackSuccess, minN).join(' ')}</p>`,
  );
  parts.push('<h3>B6 violation_rate_by_difficulty</h3>');
  parts.push(
    table(
      ['difficulty', 'rate', 'k/n', '95% CI'],
      a.violationRateByDifficulty.map((d) => [esc(d.difficulty), ...summaryCell(d.summary, minN)]),
    ),
  );

  for (const b of a.benchmarks) {
    parts.push(
      `<h2>${esc(b.benchmark)} — ${esc(BENCHMARK_TITLES[b.benchmark])} <span class="muted">(${b.graded}/${b.runs} graded)</span></h2>`,
    );
    parts.push(
      table(
        ['metric', 'value', 'n', 'note'],
        Object.entries(b.metrics).map(([k, s]) => [esc(k), ...summaryCell(s, minN)]),
      ),
    );
    const vr = Object.entries(b.violationRuns);
    if (vr.length > 0)
      parts.push(
        table(
          ['violation', 'runs with it'],
          vr.map(([k, n]) => [esc(k), esc(n)]),
        ),
      );
  }

  parts.push('<h2>Runs</h2>');
  parts.push(
    table(
      ['run', 'scenario', 'variant', 'task_success', 'policy_compliance'],
      input.runs.map((r) => [
        r.reportHref ? `<a href="${esc(r.reportHref)}">${esc(r.runId)}</a>` : esc(r.runId),
        esc(r.scenarioId),
        esc(r.variant),
        fmtMetric(r.taskSuccess),
        r.policyCompliance ? '<span class="ok">true</span>' : '<span class="bad">false</span>',
      ]),
    ),
  );
  return page(title, parts.join('\n'));
}
