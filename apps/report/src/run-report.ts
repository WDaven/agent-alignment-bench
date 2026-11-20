import {
  BENCHMARK_TITLES,
  type Episode,
  type GradeReport,
  type RunEvent,
  type RunEventOf,
  type RunMetadata,
} from '@aab/protocol';
import { escapeHtml, eventAnchor, eventLink, fmtMetric, jsonCell, page, table } from './html.js';

export interface RunReportInput {
  readonly episode: Episode | null;
  readonly meta: RunMetadata | null;
  readonly events: readonly RunEvent[];
  readonly grades: GradeReport | null;
  readonly validationWarnings?: readonly string[];
  readonly problems?: readonly string[];
  readonly screenshots?: readonly string[];
}

function roleLabel(e: RunEvent): string {
  return e.role === 'funding_subagent' ? `child ${e.delegationId ?? '(no delegation)'}` : e.role;
}

function summarize(e: RunEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.eventType) {
    case 'action.attempted':
      return `${escapeHtml(e.payload.action)} via ${escapeHtml(e.payload.via)} ${jsonCell(e.payload.request, 160)}`;
    case 'action.committed':
      return `<span class="ok">committed</span> ${escapeHtml(e.payload.action)}`;
    case 'action.denied':
      return `<span class="bad">denied</span> ${escapeHtml(e.payload.action)}: ${escapeHtml(e.payload.reason)} (${escapeHtml(e.payload.category)})`;
    case 'page.navigated':
    case 'network.request':
      return `${escapeHtml(p.method)} ${escapeHtml(p.url)} → ${escapeHtml(p.status)}`;
    case 'network.denied':
      return `<span class="bad">${escapeHtml(e.payload.reason)}</span> ${escapeHtml(e.payload.host)}:${escapeHtml(e.payload.port)}`;
    case 'trap.exposed':
      return `<span class="bad">trap ${escapeHtml(e.payload.trapId)}</span> (${escapeHtml(e.payload.trapType)}) on ${escapeHtml(e.payload.surface)}`;
    case 'agent.final_response':
      return `<em>final response (not evidence)</em>: ${escapeHtml(e.payload.text.slice(0, 200))}`;
    default:
      return jsonCell(e.payload, 200);
  }
}

export function renderRunReport(input: RunReportInput): string {
  const { episode, meta, events, grades } = input;
  const title = `Run ${meta?.runId ?? grades?.runId ?? episode?.runId ?? 'unknown'}`;
  const parts: string[] = [`<h1>${escapeHtml(title)}</h1>`];

  parts.push(
    table(
      ['field', 'value'],
      [
        ['scenario', escapeHtml(episode?.scenarioId ?? meta?.scenarioId ?? '?')],
        [
          'variant / pair',
          `${escapeHtml(episode?.variant ?? '?')} / ${escapeHtml(episode?.pairId ?? '?')}`,
        ],
        ['benchmarks', escapeHtml(episode?.benchmarkIds.join(', ') ?? '?')],
        [
          'seed / difficulty',
          `${escapeHtml(episode?.seed ?? meta?.seed ?? '?')} / ${escapeHtml(episode?.difficulty ?? '?')}`,
        ],
        ['agent', escapeHtml(meta ? `${meta.agent.agentId} (${meta.agent.kind})` : '?')],
        [
          'model',
          escapeHtml(meta ? `${meta.agent.model ?? 'n/a'} ${meta.agent.modelVersion ?? ''}` : '?'),
        ],
        [
          'prompt / grader / protocol',
          escapeHtml(
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
  parts.push(
    `<h2>Task</h2><pre>${escapeHtml(episode?.userTask ?? '(episode.json missing)')}</pre>`,
  );

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
          ['failure_reason', escapeHtml(g.failure_reason ?? '')],
        ],
      ),
    );
  } else parts.push('<h2>Outcome</h2><p class="bad">grades.json missing — run not graded.</p>');

  const warnings = new Set<string>(input.validationWarnings ?? []);
  for (const gr of grades?.grades ?? [])
    for (const n of gr.notes)
      if (n.startsWith('validation: ')) warnings.add(n.slice('validation: '.length));
  const problems = input.problems ?? [];
  parts.push('<h2>Validation warnings</h2>');
  parts.push(
    warnings.size + problems.length === 0
      ? '<p class="ok">none</p>'
      : `<ul class="warn">${[...problems, ...warnings].map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`,
  );

  const cited = new Set<string>();
  parts.push('<h2>Grades</h2>');
  for (const gr of grades?.grades ?? []) {
    for (const v of gr.violations) for (const id of v.eventIds) cited.add(id);
    parts.push(
      `<h3>${escapeHtml(gr.benchmark)} — ${escapeHtml(BENCHMARK_TITLES[gr.benchmark])} <span class="muted">(${escapeHtml(gr.status)})</span></h3>`,
    );
    parts.push(
      table(
        ['metric', 'value'],
        Object.entries(gr.metrics).map(([k, v]) => [escapeHtml(k), fmtMetric(v)]),
      ),
    );
    parts.push(
      table(
        ['violation', 'severity', 'executed', 'message', 'events'],
        gr.violations.map((v) => [
          `<span class="bad">${escapeHtml(v.code)}</span>`,
          escapeHtml(v.severity),
          v.executed ? '<span class="bad">yes</span>' : 'no (attempted)',
          escapeHtml(v.message),
          v.eventIds.map(eventLink).join(' '),
        ]),
      ),
    );
    if (gr.trapOutcomes.length > 0)
      parts.push(
        table(
          ['trap', 'exposure', 'outcome', 'events'],
          gr.trapOutcomes.map((t) => [
            escapeHtml(t.trapId),
            escapeHtml(t.exposure),
            escapeHtml(t.outcome),
            t.eventIds.map(eventLink).join(' '),
          ]),
        ),
      );
    const other = gr.notes.filter((n) => !n.startsWith('validation: '));
    if (other.length > 0)
      parts.push(
        `<ul class="muted">${other.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`,
      );
  }

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
            ? `<span class="ok">committed</span> ${eventLink(o.eventId)}`
            : `<span class="bad">denied: ${escapeHtml(o.payload.reason)}</span> ${eventLink(o.eventId)}`;
        const flag = cited.has(a.eventId) ? ' <span class="bad">[cited]</span>' : '';
        return [
          `${eventLink(a.eventId)} ${escapeHtml(a.seq)}${flag}`,
          escapeHtml(roleLabel(a)),
          escapeHtml(a.payload.action),
          jsonCell(a.payload.request, 160),
          'yes',
          o?.eventType === 'action.committed' ? '<span class="ok">yes</span>' : 'no',
          escapeHtml(decision),
          outcome,
        ];
      }),
    ),
  );

  const denials = events.filter(
    (e): e is RunEventOf<'network.denied'> => e.eventType === 'network.denied',
  );
  parts.push('<h2>Network denials</h2>');
  parts.push(
    table(
      ['event', 'actor', 'host', 'port', 'transport', 'reason', 'url'],
      denials.map((d) => [
        eventLink(d.eventId),
        escapeHtml(roleLabel(d)),
        escapeHtml(d.payload.host),
        escapeHtml(d.payload.port),
        escapeHtml(d.payload.transport),
        `<span class="bad">${escapeHtml(d.payload.reason)}</span>`,
        escapeHtml(d.payload.url ?? ''),
      ]),
    ),
  );

  if ((input.screenshots ?? []).length > 0) {
    parts.push('<h2>Snapshots</h2><ul>');
    for (const s of input.screenshots ?? [])
      parts.push(
        `<li><a href="screenshots/${escapeHtml(encodeURIComponent(s))}">${escapeHtml(s)}</a></li>`,
      );
    parts.push('</ul>');
  }

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
    parts.push(`<h3>${escapeHtml(label)} — ${evs.length} events</h3>`);
    parts.push(
      table(
        ['seq', 'event', 'type', 'page', 'summary'],
        evs.map((e) => [
          `<span id="${escapeHtml(eventAnchor(e.eventId))}"${cited.has(e.eventId) ? ' class="cited"' : ''}>${escapeHtml(e.seq)}</span>`,
          escapeHtml(e.eventId),
          escapeHtml(e.eventType),
          escapeHtml(e.pageUrl ?? ''),
          summarize(e),
        ]),
      ),
    );
  }

  return page(title, parts.join('\n'));
}
