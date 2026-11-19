/**
 * Single-run report (spec §11): task, model, scenario, attempted/executed timeline with
 * allowed/denied, parent vs child traces, violations with event links, validation warnings,
 * network denials. Pure: returns an HTML string; the runner writes it via @aab/artifacts.
 */
import {
  BENCHMARK_TITLES,
  type Episode,
  type GradeReport,
  type RunEvent,
  type RunEventOf,
  type RunMetadata,
} from '@aab/protocol';
import { esc, evAnchor, evLink, fmtMetric, jsonCell, page, table } from './html.js';

export interface RunReportInput {
  readonly episode: Episode | null;
  readonly meta: RunMetadata | null;
  readonly events: readonly RunEvent[];
  readonly grades: GradeReport | null;
  /** From gradeEpisode().validationWarnings; validation notes inside grades are merged in too. */
  readonly validationWarnings?: readonly string[];
  /** Artifact read problems (missing/invalid files). */
  readonly problems?: readonly string[];
  /** Screenshot file names under screenshots/. */
  readonly screenshots?: readonly string[];
}

function roleLabel(e: RunEvent): string {
  return e.role === 'funding_subagent' ? `child ${e.delegationId ?? '(no delegation)'}` : e.role;
}

function summarize(e: RunEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.eventType) {
    case 'action.attempted':
      return `${esc(e.payload.action)} via ${esc(e.payload.via)} ${jsonCell(e.payload.request, 160)}`;
    case 'action.committed':
      return `<span class="ok">committed</span> ${esc(e.payload.action)}`;
    case 'action.denied':
      return `<span class="bad">denied</span> ${esc(e.payload.action)}: ${esc(e.payload.reason)} (${esc(e.payload.category)})`;
    case 'page.navigated':
    case 'network.request':
      return `${esc(p['method'])} ${esc(p['url'])} → ${esc(p['status'])}`;
    case 'network.denied':
      return `<span class="bad">${esc(e.payload.reason)}</span> ${esc(e.payload.host)}:${esc(e.payload.port)}`;
    case 'trap.exposed':
      return `<span class="bad">trap ${esc(e.payload.trapId)}</span> (${esc(e.payload.trapType)}) on ${esc(e.payload.surface)}`;
    case 'agent.final_response':
      return `<em>final response (not evidence)</em>: ${esc(e.payload.text.slice(0, 200))}`;
    default:
      return jsonCell(e.payload, 200);
  }
}

export function renderRunReport(input: RunReportInput): string {
  const { episode, meta, events, grades } = input;
  const title = `Run ${meta?.runId ?? grades?.runId ?? episode?.runId ?? 'unknown'}`;
  const parts: string[] = [`<h1>${esc(title)}</h1>`];

  // ---- header
  parts.push(
    table(
      ['field', 'value'],
      [
        ['scenario', esc(episode?.scenarioId ?? meta?.scenarioId ?? '?')],
        ['variant / pair', `${esc(episode?.variant ?? '?')} / ${esc(episode?.pairId ?? '?')}`],
        ['benchmarks', esc(episode?.benchmarkIds.join(', ') ?? '?')],
        [
          'seed / difficulty',
          `${esc(episode?.seed ?? meta?.seed ?? '?')} / ${esc(episode?.difficulty ?? '?')}`,
        ],
        ['agent', esc(meta ? `${meta.agent.agentId} (${meta.agent.kind})` : '?')],
        [
          'model',
          esc(meta ? `${meta.agent.model ?? 'n/a'} ${meta.agent.modelVersion ?? ''}` : '?'),
        ],
        [
          'prompt / grader / protocol',
          esc(
            meta
              ? `${meta.agent.promptVersion} / ${meta.graderVersion} / ${meta.protocolVersion}`
              : (grades?.graderVersion ?? '?'),
          ),
        ],
        [
          'isolation',
          meta
            ? meta.isolation === 'proxy-only'
              ? '<span class="bad">proxy-only (development run; proxy is not a security boundary)</span>'
              : 'container'
            : '?',
        ],
      ],
    ),
  );
  parts.push(`<h2>Task</h2><pre>${esc(episode?.userTask ?? '(episode.json missing)')}</pre>`);

  // ---- outcome
  if (grades) {
    const g = grades.global;
    parts.push('<h2>Outcome</h2>');
    parts.push(
      table(
        ['output', 'value'],
        [
          ['task_success', fmtMetric(g.task_success)],
          [
            'policy_compliance',
            g.policy_compliance ? '<span class="ok">true</span>' : '<span class="bad">false</span>',
          ],
          ['unauthorized_attempted', fmtMetric(g.unauthorized_attempted)],
          ['unauthorized_executed', fmtMetric(g.unauthorized_executed)],
          ['detection_or_recovery', fmtMetric(g.detection_or_recovery)],
          ['legitimate_opportunities_missed', fmtMetric(g.legitimate_opportunities_missed)],
          ['cost_tokens_or_actions', fmtMetric(g.cost_tokens_or_actions)],
          ['time_to_complete_virtual_ms', fmtMetric(g.time_to_complete_virtual_ms)],
          ['failure_reason', esc(g.failure_reason ?? '')],
        ],
      ),
    );
  } else parts.push('<h2>Outcome</h2><p class="bad">grades.json missing — run not graded.</p>');

  // ---- validation warnings
  const warnings = new Set<string>(input.validationWarnings ?? []);
  for (const gr of grades?.grades ?? [])
    for (const n of gr.notes)
      if (n.startsWith('validation: ')) warnings.add(n.slice('validation: '.length));
  const problems = input.problems ?? [];
  parts.push('<h2>Validation warnings</h2>');
  parts.push(
    warnings.size + problems.length === 0
      ? '<p class="ok">none</p>'
      : `<ul class="warn">${[...problems, ...warnings].map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`,
  );

  // ---- violations
  const cited = new Set<string>();
  parts.push('<h2>Grades</h2>');
  for (const gr of grades?.grades ?? []) {
    for (const v of gr.violations) for (const id of v.eventIds) cited.add(id);
    parts.push(
      `<h3>${esc(gr.benchmark)} — ${esc(BENCHMARK_TITLES[gr.benchmark])} <span class="muted">(${esc(gr.status)})</span></h3>`,
    );
    parts.push(
      table(
        ['metric', 'value'],
        Object.entries(gr.metrics).map(([k, v]) => [esc(k), fmtMetric(v)]),
      ),
    );
    parts.push(
      table(
        ['violation', 'severity', 'executed', 'message', 'events'],
        gr.violations.map((v) => [
          `<span class="bad">${esc(v.code)}</span>`,
          esc(v.severity),
          v.executed ? '<span class="bad">yes</span>' : 'no (attempted)',
          esc(v.message),
          v.eventIds.map(evLink).join(' '),
        ]),
      ),
    );
    if (gr.trapOutcomes.length > 0)
      parts.push(
        table(
          ['trap', 'exposure', 'outcome', 'events'],
          gr.trapOutcomes.map((t) => [
            esc(t.trapId),
            esc(t.exposure),
            esc(t.outcome),
            t.eventIds.map(evLink).join(' '),
          ]),
        ),
      );
    const other = gr.notes.filter((n) => !n.startsWith('validation: '));
    if (other.length > 0)
      parts.push(`<ul class="muted">${other.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`);
  }

  // ---- attempted/executed timeline
  const outcomes = new Map<string, RunEventOf<'action.committed'> | RunEventOf<'action.denied'>>();
  for (const e of events)
    if (e.eventType === 'action.committed' || e.eventType === 'action.denied')
      outcomes.set(e.payload.attemptId, e);
  const attempts = events.filter(
    (e): e is RunEventOf<'action.attempted'> => e.eventType === 'action.attempted',
  );
  parts.push('<h2>Transaction timeline (attempted vs executed)</h2>');
  parts.push(
    table(
      ['seq', 'actor', 'action', 'request', 'attempted', 'executed', 'decision', 'outcome'],
      attempts.map((a) => {
        const o = outcomes.get(a.payload.attemptId);
        const decision = o ? o.payload.authorizationDecision : 'pending';
        const outcome = !o
          ? '<span class="bad">no outcome</span>'
          : o.eventType === 'action.committed'
            ? `<span class="ok">committed</span> ${evLink(o.eventId)}`
            : `<span class="bad">denied: ${esc(o.payload.reason)}</span> ${evLink(o.eventId)}`;
        const flag = cited.has(a.eventId) ? ' <span class="bad">[cited]</span>' : '';
        return [
          `${evLink(a.eventId)} ${esc(a.seq)}${flag}`,
          esc(roleLabel(a)),
          esc(a.payload.action),
          jsonCell(a.payload.request, 160),
          'yes',
          o?.eventType === 'action.committed' ? '<span class="ok">yes</span>' : 'no',
          esc(decision),
          outcome,
        ];
      }),
    ),
  );

  // ---- network denials
  const denials = events.filter(
    (e): e is RunEventOf<'network.denied'> => e.eventType === 'network.denied',
  );
  parts.push('<h2>Network denials</h2>');
  parts.push(
    table(
      ['event', 'actor', 'host', 'port', 'transport', 'reason', 'url'],
      denials.map((d) => [
        evLink(d.eventId),
        esc(roleLabel(d)),
        esc(d.payload.host),
        esc(d.payload.port),
        esc(d.payload.transport),
        `<span class="bad">${esc(d.payload.reason)}</span>`,
        esc(d.payload.url ?? ''),
      ]),
    ),
  );

  // ---- snapshots
  if ((input.screenshots ?? []).length > 0) {
    parts.push('<h2>Snapshots</h2><ul>');
    for (const s of input.screenshots ?? [])
      parts.push(`<li><a href="screenshots/${esc(encodeURIComponent(s))}">${esc(s)}</a></li>`);
    parts.push('</ul>');
  }

  // ---- traces by actor
  const groups = new Map<string, RunEvent[]>();
  for (const e of events) {
    const key = e.role === 'funding_subagent' ? `child:${e.delegationId ?? '(none)'}` : e.role;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const order = [
    'parent',
    ...[...groups.keys()].filter((k) => k.startsWith('child:')).sort(),
    'world',
  ];
  parts.push('<h2>Traces (parent vs child)</h2>');
  for (const key of order) {
    const evs = groups.get(key);
    if (!evs) continue;
    const label =
      key === 'parent'
        ? 'Parent agent'
        : key === 'world'
          ? 'World / system'
          : `Child agent (delegation ${key.slice(6)})`;
    parts.push(`<h3>${esc(label)} — ${evs.length} events</h3>`);
    parts.push(
      table(
        ['seq', 'event', 'type', 'page', 'summary'],
        evs.map((e) => [
          `<span id="${esc(evAnchor(e.eventId))}"${cited.has(e.eventId) ? ' class="cited"' : ''}>${esc(e.seq)}</span>`,
          esc(e.eventId),
          esc(e.eventType),
          esc(e.pageUrl ?? ''),
          summarize(e),
        ]),
      ),
    );
  }

  return page(title, parts.join('\n'));
}
