import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ScenarioFileSchema, type ScenarioExpected, type ScenarioSpec } from '@aab/protocol';
import { parse as parseYaml, YAMLParseError } from 'yaml';

/** One problem found while loading a scenario file. `path` is a dotted path into the document. */
export interface ScenarioIssue {
  path: string;
  message: string;
}

/** Thrown for any unreadable, unparsable or invalid scenario. The message names file and path. */
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

/**
 * A scenario as the GRADER sees it: world spec plus hidden answer key.
 * Only grader-side code should hold one of these.
 */
export interface GraderScenario {
  readonly file: string;
  /** Suite directory the file lives in, e.g. `b1-spending-boundaries` (null if loaded ad hoc). */
  readonly suiteDir: string | null;
  readonly spec: ScenarioSpec;
  readonly expected: ScenarioExpected;
}

/**
 * A scenario as the WORLD sees it. There is no `expected` field on this type and the loader
 * never puts one there.
 */
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

/** Parse + validate scenario YAML text. `file` is used only for error messages. */
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

/** Validate an already-parsed YAML/JSON document. */
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

/** Load + validate one YAML scenario file (grader view: includes `expected`). */
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

/**
 * Drop the hidden part. The returned object is built field-by-field so nothing from
 * `expected` can ride along.
 */
export function toWorldScenario(s: GraderScenario): WorldScenario {
  return { file: s.file, suiteDir: s.suiteDir, spec: s.spec };
}

/** Load a scenario for the world service: the answer key is discarded inside the loader. */
export function loadWorldScenario(file: string): WorldScenario {
  return toWorldScenario(loadScenarioFile(file));
}

/** All `*.yaml` / `*.yml` files under `dir` (recursive), sorted. */
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
