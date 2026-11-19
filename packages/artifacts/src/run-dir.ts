/**
 * Run directory layout (docs/architecture.md):
 *
 *   runs/<runId>/ episode.json events.jsonl grades.json world-final.json
 *                 trace.zip screenshots/ network.har report.html meta.json
 *
 * JSON is written with sorted keys and LF endings so identical runs are byte-identical.
 * Every write goes through the hidden-data guard.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  EpisodeSchema,
  GradeReportSchema,
  RunEventSchema,
  RunIdSchema,
  RunMetadataSchema,
  WorldStateSchema,
  type Episode,
  type GradeReport,
  type RunEvent,
  type RunMetadata,
  type WorldState,
} from '@aab/protocol';
import { assertNoHiddenLeak, isInside } from './guard.js';
import { parseJsonl, stableStringify, stableStringifyLine, toJsonl } from './stable-json.js';

export const RUN_FILES = {
  episode: 'episode.json',
  events: 'events.jsonl',
  grades: 'grades.json',
  worldFinal: 'world-final.json',
  meta: 'meta.json',
  report: 'report.html',
  trace: 'trace.zip',
  har: 'network.har',
  screenshots: 'screenshots',
} as const;

/** Files that must not be written while the agent is live (they derive from hidden data). */
const POST_RUN_ONLY: ReadonlySet<string> = new Set([RUN_FILES.grades, RUN_FILES.report]);

export class LiveRunWriteError extends Error {
  override name = 'LiveRunWriteError';
}

export function runDirFor(root: string, runId: string): string {
  RunIdSchema.parse(runId);
  return path.join(root, runId);
}

export interface RunArtifactsOptions {
  /** Parent directory, normally `<repo>/runs`. */
  readonly root: string;
  readonly runId: string;
  /** Paths an agent can read during the run (work dir, config home...). Always guarded. */
  readonly agentReachablePaths?: readonly string[];
  /** Distinctive answer-key strings to scan for in any written content. */
  readonly hiddenMarkers?: readonly string[];
  /** Starts live (default true): the agent may be running. */
  readonly live?: boolean;
}

export class RunArtifacts {
  readonly dir: string;
  private isLive: boolean;
  private readonly agentPaths: readonly string[];
  private readonly markers: readonly string[];

  constructor(opts: RunArtifactsOptions) {
    this.dir = path.resolve(runDirFor(opts.root, opts.runId));
    this.isLive = opts.live ?? true;
    this.agentPaths = (opts.agentReachablePaths ?? []).map((p) => path.resolve(p));
    this.markers = opts.hiddenMarkers ?? [];
    for (const p of this.agentPaths)
      if (isInside(this.dir, p) || isInside(p, this.dir))
        throw new Error(`agent-reachable path ${p} overlaps the run directory ${this.dir}`);
    mkdirSync(this.dir, { recursive: true });
  }

  get live(): boolean {
    return this.isLive;
  }

  /** Mark the agent as finished (true -> false) before writing grades/report. */
  setLive(live: boolean): void {
    this.isLive = live;
  }

  private resolve(rel: string): string {
    const target = path.resolve(this.dir, rel);
    if (!isInside(target, this.dir) || target === this.dir)
      throw new Error(`artifact path escapes the run directory: ${rel}`);
    return target;
  }

  /**
   * Guarded, atomic write of a file inside the run directory.
   * `check.parsed`: the structured value behind `content` (scanned for hidden keys).
   * `check.markersOnly`: only scan for explicit hidden markers (agent-supplied payloads such as
   * raw tool arguments may legitimately contain any key name).
   */
  writeFile(
    rel: string,
    content: string | Uint8Array,
    check: { parsed?: unknown; markersOnly?: boolean } = {},
  ): string {
    const target = this.resolve(rel);
    if (this.isLive && POST_RUN_ONLY.has(path.relative(this.dir, target)))
      throw new LiveRunWriteError(`${rel} may only be written after the run (setLive(false))`);
    const opts = {
      live: this.isLive,
      runDir: this.dir,
      agentReachablePaths: this.agentPaths,
      hiddenMarkers: this.markers,
    };
    if (check.markersOnly) assertNoHiddenLeak(target, Buffer.from(content), opts);
    else {
      assertNoHiddenLeak(target, check.parsed ?? content, opts);
      if (check.parsed !== undefined && this.markers.length > 0)
        assertNoHiddenLeak(target, Buffer.from(content), opts);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, content);
    renameSync(tmp, target);
    return target;
  }

  private writeJson(rel: string, value: unknown): string {
    return this.writeFile(rel, stableStringify(value), { parsed: value });
  }

  writeEpisode(episode: Episode): string {
    return this.writeJson(RUN_FILES.episode, EpisodeSchema.parse(episode));
  }

  /** Replace events.jsonl with the given journal (each event schema-checked). */
  writeEvents(events: readonly RunEvent[]): string {
    const parsed = events.map((e) => RunEventSchema.parse(e));
    // The world never holds hidden data; raw agent requests may contain any key, so only markers are checked.
    return this.writeFile(RUN_FILES.events, toJsonl(parsed), { markersOnly: true });
  }

  writeGrades(report: GradeReport): string {
    return this.writeJson(RUN_FILES.grades, GradeReportSchema.parse(report));
  }

  writeWorldFinal(state: WorldState): string {
    return this.writeJson(RUN_FILES.worldFinal, WorldStateSchema.parse(state));
  }

  writeMeta(meta: RunMetadata): string {
    return this.writeJson(RUN_FILES.meta, RunMetadataSchema.parse(meta));
  }

  writeReportHtml(html: string): string {
    return this.writeFile(RUN_FILES.report, html);
  }

  writeTrace(zip: Uint8Array): string {
    return this.writeFile(RUN_FILES.trace, zip);
  }

  writeHar(har: string | object): string {
    // HAR bodies are agent/page traffic: only explicit markers are meaningful.
    return this.writeFile(RUN_FILES.har, typeof har === 'string' ? har : stableStringify(har), {
      markersOnly: true,
    });
  }

  /** `screenshots/<name>`; name must be a plain file name. */
  writeScreenshot(name: string, png: Uint8Array): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
      throw new Error(`bad screenshot name ${name}`);
    return this.writeFile(path.join(RUN_FILES.screenshots, name), png);
  }

  /** Copy an existing file (e.g. a Playwright trace) into the run directory, guarded. */
  copyIn(rel: string, sourcePath: string): string {
    return this.writeFile(rel, readFileSync(sourcePath));
  }
}

/** Serialize one event exactly as it appears in events.jsonl (without the newline). */
export function eventLine(e: RunEvent): string {
  return stableStringifyLine(e);
}

export interface RunArtifactsData {
  readonly dir: string;
  readonly episode: Episode | null;
  readonly events: readonly RunEvent[];
  readonly grades: GradeReport | null;
  readonly worldFinal: WorldState | null;
  readonly meta: RunMetadata | null;
  readonly screenshots: readonly string[];
  readonly hasTrace: boolean;
  readonly hasHar: boolean;
  readonly hasReport: boolean;
  /** Missing or invalid files. Reading never throws for a malformed run. */
  readonly problems: readonly string[];
}

function readJson<T>(file: string, parse: (v: unknown) => T, problems: string[]): T | null {
  if (!existsSync(file)) {
    problems.push(`missing ${path.basename(file)}`);
    return null;
  }
  try {
    return parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    problems.push(
      `invalid ${path.basename(file)}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    );
    return null;
  }
}

/** Read and schema-validate a run directory. */
export function readRun(dir: string): RunArtifactsData {
  const problems: string[] = [];
  const f = (n: string) => path.join(dir, n);
  const episode = readJson(f(RUN_FILES.episode), (v) => EpisodeSchema.parse(v), problems);
  let events: RunEvent[] = [];
  if (existsSync(f(RUN_FILES.events))) {
    try {
      events = parseJsonl(readFileSync(f(RUN_FILES.events), 'utf8')).map((v, i) => {
        const r = RunEventSchema.safeParse(v);
        if (!r.success) throw new Error(`event line ${i + 1} does not match RunEventSchema`);
        return r.data;
      });
    } catch (err) {
      problems.push(`invalid events.jsonl: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else problems.push('missing events.jsonl');
  const grades = existsSync(f(RUN_FILES.grades))
    ? readJson(f(RUN_FILES.grades), (v) => GradeReportSchema.parse(v), problems)
    : null;
  const worldFinal = existsSync(f(RUN_FILES.worldFinal))
    ? readJson(f(RUN_FILES.worldFinal), (v) => WorldStateSchema.parse(v), problems)
    : null;
  const meta = existsSync(f(RUN_FILES.meta))
    ? readJson(f(RUN_FILES.meta), (v) => RunMetadataSchema.parse(v), problems)
    : null;
  const shots = existsSync(f(RUN_FILES.screenshots))
    ? readdirSync(f(RUN_FILES.screenshots))
        .filter((n) => !n.includes('.tmp-'))
        .sort()
    : [];
  return {
    dir,
    episode,
    events,
    grades,
    worldFinal,
    meta,
    screenshots: shots,
    hasTrace: existsSync(f(RUN_FILES.trace)),
    hasHar: existsSync(f(RUN_FILES.har)),
    hasReport: existsSync(f(RUN_FILES.report)),
    problems,
  };
}
