import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ScenarioFileSchema, type ScenarioExpected, type ScenarioSpec } from '@aab/protocol';
import { parse as parseYaml, YAMLParseError } from 'yaml';

export interface ScenarioIssue {
  path: string;
  message: string;
}

export class ScenarioLoadError extends Error {
  override name = 'ScenarioLoadError';
  constructor(
    readonly file: string,
    readonly issues: readonly ScenarioIssue[],
  ) {
    super(
      `invalid scenario ${file}:\n` +
        issues.map((i) => `  - ${i.path || '<root>'}: ${i.message}`).join('\n'),
    );
  }
}

export interface GraderScenario {
  readonly file: string;
  readonly suiteDir: string | null;
  readonly spec: ScenarioSpec;
  readonly expected: ScenarioExpected;
}

export interface WorldScenario {
  readonly file: string;
  readonly suiteDir: string | null;
  readonly spec: ScenarioSpec;
}

function formatPath(p: readonly PropertyKey[]): string {
  return p
    .map((k, i) => (typeof k === 'number' ? `[${k}]` : `${i === 0 ? '' : '.'}${String(k)}`))
    .join('');
}

export function parseScenarioYaml(
  text: string,
  file = '<inline>',
  suiteDir: string | null = null,
): GraderScenario {
  let doc: unknown;
  try {
    doc = parseYaml(text, { prettyErrors: true, uniqueKeys: true });
  } catch (err) {
    const msg = err instanceof YAMLParseError ? err.message : String(err);
    throw new ScenarioLoadError(file, [{ path: '', message: `YAML parse error: ${msg}` }]);
  }
  return parseScenarioObject(doc, file, suiteDir);
}

export function parseScenarioObject(
  doc: unknown,
  file = '<inline>',
  suiteDir: string | null = null,
): GraderScenario {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ScenarioLoadError(file, [{ path: '', message: 'scenario must be a YAML mapping' }]);
  }
  const r = ScenarioFileSchema.safeParse(doc);
  if (!r.success) {
    throw new ScenarioLoadError(
      file,
      r.error.issues.map((i) => ({ path: formatPath(i.path), message: i.message })),
    );
  }
  return { file, suiteDir, spec: r.data.spec, expected: r.data.expected };
}

export function loadScenarioFile(file: string): GraderScenario {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new ScenarioLoadError(file, [{ path: '', message: `cannot read file: ${String(err)}` }]);
  }
  const suiteDir = path.basename(path.dirname(file));
  return parseScenarioYaml(text, file, /^b\d+-/i.test(suiteDir) ? suiteDir : null);
}

export function toWorldScenario(s: GraderScenario): WorldScenario {
  return { file: s.file, suiteDir: s.suiteDir, spec: s.spec };
}

export function loadWorldScenario(file: string): WorldScenario {
  return toWorldScenario(loadScenarioFile(file));
}

export function listScenarioFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ya?ml$/i.test(name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}
