import { isDeepStrictEqual } from 'node:util';
import type { BenchmarkId, ScenarioExpected, ScenarioSpec } from '@aab/protocol';
import {
  listScenarioFiles,
  loadScenarioFile,
  ScenarioLoadError,
  toWorldScenario,
  type GraderScenario,
  type WorldScenario,
} from './load.js';

export class ScenarioCatalog {
  private readonly byId = new Map<string, GraderScenario>();

  constructor(scenarios: readonly GraderScenario[]) {
    for (const s of scenarios) {
      const prev = this.byId.get(s.spec.id);
      if (prev) {
        throw new ScenarioLoadError(s.file, [
          { path: 'id', message: `duplicate scenario id ${s.spec.id} (also in ${prev.file})` },
        ]);
      }
      this.byId.set(s.spec.id, s);
    }
  }

  static loadDir(dir: string): ScenarioCatalog {
    const loaded: GraderScenario[] = [];
    const errors: ScenarioLoadError[] = [];
    for (const f of listScenarioFiles(dir)) {
      try {
        loaded.push(loadScenarioFile(f));
      } catch (err) {
        if (err instanceof ScenarioLoadError) errors.push(err);
        else throw err;
      }
    }
    if (errors.length) {
      const e = new Error(errors.map((x) => x.message).join('\n'));
      e.name = 'ScenarioLoadError';
      throw e;
    }
    return new ScenarioCatalog(loaded);
  }

  ids(): string[] {
    return [...this.byId.keys()].sort();
  }

  all(): GraderScenario[] {
    return this.ids().flatMap((id) => this.byId.get(id) ?? []);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  getForGrader(id: string): GraderScenario {
    const s = this.byId.get(id);
    if (!s) throw new Error(`unknown scenario ${id}`);
    return s;
  }

  getForWorld(id: string): WorldScenario {
    return toWorldScenario(this.getForGrader(id));
  }

  resolveSuite(suite: string): string[] {
    const out = new Set<string>();
    for (const raw of suite
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const part = raw.toLowerCase();
      let matched: GraderScenario[];
      if (part === 'all') matched = this.all();
      else if (part.startsWith('tag:')) {
        const b = raw.slice(4).toUpperCase() as BenchmarkId;
        matched = this.all().filter((s) => s.spec.benchmarkIds.includes(b));
      } else if (/^b\d+$/.test(part)) {
        matched = this.all().filter((s) => s.suiteDir?.toLowerCase().startsWith(`${part}-`));
      } else {
        matched = this.all().filter((s) => s.suiteDir?.toLowerCase() === part);
      }
      if (matched.length === 0) throw new Error(`suite "${raw}" matched no scenarios`);
      for (const s of matched) out.add(s.spec.id);
    }
    return [...out].sort();
  }

  pairOf(id: string): {
    pairId: string;
    clean: GraderScenario | null;
    adversarial: GraderScenario[];
  } {
    const s = this.getForGrader(id);
    const members = this.all().filter((x) => x.spec.pairId === s.spec.pairId);
    const cleans = members.filter((x) => x.spec.variant === 'clean');
    if (cleans.length > 1) {
      throw new Error(`pair ${s.spec.pairId} has ${cleans.length} clean variants`);
    }
    return {
      pairId: s.spec.pairId,
      clean: cleans[0] ?? null,
      adversarial: members.filter((x) => x.spec.variant === 'adversarial'),
    };
  }

  pairs(): { pairId: string; clean: GraderScenario; adversarial: GraderScenario[] }[] {
    const ids = [...new Set(this.all().map((s) => s.spec.pairId))].sort();
    const out: { pairId: string; clean: GraderScenario; adversarial: GraderScenario[] }[] = [];
    for (const pid of ids) {
      const first = this.all().find((s) => s.spec.pairId === pid);
      if (!first) continue;
      const p = this.pairOf(first.spec.id);
      if (p.clean && p.adversarial.length)
        out.push({ pairId: pid, clean: p.clean, adversarial: p.adversarial });
    }
    return out;
  }
}

function stripTrapParts(spec: ScenarioSpec, expected: ScenarioExpected | null) {
  const { id: _id, title: _title, variant: _variant, world, ...rest } = spec;
  const { traps: _traps, searchIndex, ...worldRest } = world;
  const strippedExpected = expected
    ? (() => {
        const { traps: _t, notes: _n, ...e } = expected;
        return e;
      })()
    : null;
  return {
    spec: {
      ...rest,
      world: { ...worldRest, searchIndex: searchIndex.filter((d) => d.trapId === null) },
    },
    expected: strippedExpected,
  };
}

function diffPaths(a: unknown, b: unknown, at: string, out: string[]): void {
  if (isDeepStrictEqual(a, b)) return;
  if (
    a &&
    b &&
    typeof a === 'object' &&
    typeof b === 'object' &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) {
      diffPaths(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        at ? `${at}.${k}` : k,
        out,
      );
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    a.forEach((v, i) => {
      diffPaths(v, b[i], `${at}[${i}]`, out);
    });
    return;
  }
  out.push(at || '<root>');
}

export function pairDifferences(
  clean: { spec: ScenarioSpec; expected?: ScenarioExpected },
  adversarial: { spec: ScenarioSpec; expected?: ScenarioExpected },
): string[] {
  const out: string[] = [];
  if (clean.spec.pairId !== adversarial.spec.pairId) out.push('pairId');
  if (clean.spec.variant !== 'clean') out.push('variant (first argument must be clean)');
  if (adversarial.spec.variant !== 'adversarial')
    out.push('variant (second argument must be adversarial)');
  const a = stripTrapParts(clean.spec, clean.expected ?? null);
  const b = stripTrapParts(adversarial.spec, adversarial.expected ?? null);
  diffPaths(a.spec, b.spec, 'spec', out);
  if (a.expected && b.expected) diffPaths(a.expected, b.expected, 'expected', out);
  return out;
}
