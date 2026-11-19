import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { RunArtifacts, readRun, stableStringify, type RunArtifactsData } from '@aab/artifacts';
import {
  aggregate,
  gradeEpisode,
  type AggregateRunInput,
  type EpisodeGradeResult,
} from '@aab/graders';
import { WorldStateSchema, type WorldState } from '@aab/protocol';
import { renderRunReport, renderSuiteSummary, type SuiteRunRow } from '@aab/report';
import { ScenarioCatalog } from '@aab/scenarios';
import { initialProjection } from '@aab/world-state';

/**
 * Re-grade a run from its artifacts only (events.jsonl + episode.json + world-final.json +
 * world-initial.json), loading the scenario's hidden answer key from the scenarios directory.
 */
export function regradeRun(
  runDir: string,
  scenariosDir: string,
): { data: RunArtifactsData; result: EpisodeGradeResult } {
  const data = readRun(runDir);
  if (!data.episode) throw new Error(`${runDir}: ${data.problems.join('; ') || 'no episode.json'}`);
  if (data.events.length === 0) throw new Error(`${runDir}: no events`);
  const catalog = ScenarioCatalog.loadDir(scenariosDir);
  const g = catalog.getForGrader(data.episode.scenarioId);
  const spec = { ...g.spec, seed: data.episode.seed };
  const initialFile = path.join(runDir, 'world-initial.json');
  const initialState: WorldState = existsSync(initialFile)
    ? WorldStateSchema.parse(JSON.parse(readFileSync(initialFile, 'utf8')))
    : initialProjection(spec, data.episode.id).world;
  if (!data.worldFinal) throw new Error(`${runDir}: no world-final.json`);
  const result = gradeEpisode({
    episode: data.episode,
    spec,
    expected: g.expected,
    initialState,
    events: data.events,
    finalState: data.worldFinal,
    usage: data.meta?.toolCost ?? null,
  });
  return { data, result };
}

/** Rewrite grades.json + report.html of a finished run. */
export function writeRegrade(runDir: string, scenariosDir: string): EpisodeGradeResult {
  const { data, result } = regradeRun(runDir, scenariosDir);
  const a = new RunArtifacts({
    root: path.dirname(runDir),
    runId: path.basename(runDir),
    live: false,
  });
  a.writeGrades(result.report);
  a.writeReportHtml(
    renderRunReport({
      episode: data.episode,
      meta: data.meta,
      events: data.events,
      grades: result.report,
      validationWarnings: result.validationWarnings,
      problems: data.problems,
      screenshots: data.screenshots,
    }),
  );
  return result;
}

/** (Re)render report.html of a run from its artifacts (no re-grading). */
export function renderReportFor(runDir: string): string {
  const data = readRun(runDir);
  const a = new RunArtifacts({
    root: path.dirname(runDir),
    runId: path.basename(runDir),
    live: false,
  });
  return a.writeReportHtml(
    renderRunReport({
      episode: data.episode,
      meta: data.meta,
      events: data.events,
      grades: data.grades,
      validationWarnings: data.grades?.validationWarnings ?? [],
      problems: data.problems,
      screenshots: data.screenshots,
    }),
  );
}

/** Suite summary over every run directory directly under `dir` (or listed run dirs). */
export function writeSuiteSummary(dir: string, title?: string): { file: string; runs: number } {
  const runDirs = readdirSync(dir)
    .map((n) => path.join(dir, n))
    .filter((d) => statSync(d).isDirectory() && existsSync(path.join(d, 'grades.json')))
    .sort();
  const inputs: AggregateRunInput[] = [];
  const rows: SuiteRunRow[] = [];
  for (const d of runDirs) {
    const r = readRun(d);
    if (!r.episode || !r.grades) continue;
    inputs.push({ episode: r.episode, report: r.grades });
    rows.push({
      runId: r.episode.runId,
      scenarioId: r.episode.scenarioId,
      variant: r.episode.variant,
      taskSuccess: r.grades.global.task_success,
      policyCompliance: r.grades.global.policy_compliance,
      reportHref: `${path.basename(d)}/report.html`,
    });
  }
  const agg = aggregate(inputs);
  const html = renderSuiteSummary({
    title: title ?? `Suite summary (${rows.length} runs)`,
    aggregate: agg,
    runs: rows,
  });
  const file = path.join(dir, 'summary.html');
  // Derived, post-run outputs (no agent is live).
  writeFileSync(file, html);
  writeFileSync(path.join(dir, 'summary.json'), stableStringify(agg));
  return { file, runs: rows.length };
}
