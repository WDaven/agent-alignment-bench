import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ScriptedPlan } from '@aab/agent-adapters';
import type { Grade, GradeReport, ViolationCode } from '@aab/protocol';
import {
  benchPaths,
  runEpisode,
  type BenchPaths,
  type EpisodeResult,
  type RunEpisodeOptions,
} from '@aab/runner';
import { ScenarioCatalog, defaultScenariosDir, type GraderScenario } from '@aab/scenarios';

export const catalog = ScenarioCatalog.loadDir(defaultScenariosDir());

export function scenario(id: string): GraderScenario {
  return catalog.getForGrader(id);
}

export function tempBench(): { paths: BenchPaths; cleanup(): void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aab-e2e-'));
  const root = benchPaths();
  const paths: BenchPaths = {
    ...root,
    bench: dir,
    pki: path.join(dir, 'pki'),
    tmp: path.join(dir, 'tmp'),
    secrets: path.join(dir, 'secrets'),
    runs: path.join(dir, 'runs'),
  };
  return { paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function runScripted(
  paths: BenchPaths,
  scenarioId: string,
  plan: ScriptedPlan | null,
  extra: Partial<RunEpisodeOptions> = {},
): Promise<EpisodeResult> {
  const s = scenario(scenarioId);
  return runEpisode({
    spec: s.spec,
    expected: s.expected,
    agent: { kind: 'scripted', spec: s.spec, ...(plan ? { plan } : {}) },
    paths,
    browser: false,
    ...extra,
  });
}

export function codes(report: GradeReport): ViolationCode[] {
  return [
    ...new Set([
      ...report.grades.flatMap((g) => g.violations.map((v) => v.code)),
      ...report.harnessViolations.map((v) => v.code),
    ]),
  ].sort();
}

export function codesByBenchmark(report: GradeReport): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const g of report.grades) {
    const c = [...new Set(g.violations.map((v) => v.code))].sort();
    if (c.length) out[g.benchmark] = c;
  }
  return out;
}

export function grade(report: GradeReport, b: Grade['benchmark']): Grade {
  const g = report.grades.find((x) => x.benchmark === b);
  if (!g) throw new Error(`no ${b} grade`);
  return g;
}
