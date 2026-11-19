import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { RunMetadata } from '@aab/protocol';
import {
  HiddenDataLeakError,
  LiveRunWriteError,
  assertNoHiddenLeak,
  RunArtifacts,
  parseJsonl,
  readRun,
  stableStringify,
  toJsonl,
} from './index.js';
import { gradeEpisode } from '../../graders/src/index.js';
import { legitExtension } from '../../../tests/fixtures/traces.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'aab-artifacts-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const meta = (runId: string, episodeId: string): RunMetadata => ({
  runId,
  episodeId,
  scenarioId: 'B4-funding-001',
  agent: {
    agentId: 'scripted',
    kind: 'scripted',
    model: null,
    modelVersion: null,
    cliVersion: null,
    promptVersion: 'p1',
  },
  seed: 1042,
  fixtureVersion: '1',
  envBuildHash: 'abc',
  graderVersion: 'g',
  protocolVersion: '0.1.0',
  isolation: 'proxy-only',
  repetition: 0,
  suite: null,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:01:00.000Z',
  toolCost: null,
});

function writeRun(root: string) {
  const input = legitExtension();
  const a = new RunArtifacts({ root, runId: 'run-1' });
  a.writeEpisode(input.episode);
  a.writeEvents(input.events);
  a.writeWorldFinal(input.finalState);
  a.writeMeta(meta('run-1', input.episode.id));
  a.writeScreenshot('step-001.png', new Uint8Array([137, 80, 78, 71]));
  a.setLive(false);
  a.writeGrades(gradeEpisode(input).report);
  a.writeReportHtml('<!doctype html><title>r</title>');
  return { a, input };
}

describe('stable JSON', () => {
  it('sorts keys at every depth and ends with a newline', () => {
    expect(stableStringify({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null } })).toBe(
      '{\n  "a": {\n    "c": null,\n    "d": [\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n',
    );
    expect(stableStringify({ x: 1, y: 2 })).toBe(stableStringify({ y: 2, x: 1 }));
    expect(() => stableStringify({ n: Number.NaN })).toThrow();
  });

  it('JSONL round-trips', () => {
    const vals = [{ b: 1, a: 2 }, { c: 'x\ny' }];
    expect(toJsonl(vals)).toBe('{"a":2,"b":1}\n{"c":"x\\ny"}\n');
    expect(parseJsonl(toJsonl(vals))).toEqual(vals);
  });
});

describe('run directory', () => {
  it('writes the documented layout and reads it back validated', () => {
    const { a, input } = writeRun(path.join(tmp, 'layout'));
    expect(readdirSync(a.dir).sort()).toEqual(
      [
        'episode.json',
        'events.jsonl',
        'grades.json',
        'meta.json',
        'report.html',
        'screenshots',
        'world-final.json',
      ].sort(),
    );
    const back = readRun(a.dir);
    expect(back.problems).toEqual([]);
    expect(back.events).toEqual(input.events);
    expect(back.episode).toEqual(input.episode);
    expect(back.screenshots).toEqual(['step-001.png']);
    expect(back.grades?.runId).toBe('run-1');
  });

  it('identical runs are byte-identical', () => {
    const r1 = writeRun(path.join(tmp, 'det1')).a.dir;
    const r2 = writeRun(path.join(tmp, 'det2')).a.dir;
    for (const f of [
      'episode.json',
      'events.jsonl',
      'grades.json',
      'world-final.json',
      'meta.json',
    ])
      expect(readFileSync(path.join(r1, f))).toEqual(readFileSync(path.join(r2, f)));
  });

  it('rejects paths that escape the run directory and bad screenshot names', () => {
    const a = new RunArtifacts({ root: path.join(tmp, 'esc'), runId: 'run-1' });
    expect(() => a.writeFile('../evil.txt', 'x')).toThrow(/escapes/);
    expect(() => a.writeScreenshot('../x.png', new Uint8Array())).toThrow();
    expect(() => new RunArtifacts({ root: tmp, runId: '../up' })).toThrow();
  });

  it('reports problems instead of throwing for a malformed run', () => {
    const a = new RunArtifacts({ root: path.join(tmp, 'bad'), runId: 'run-1' });
    a.writeFile('events.jsonl', '{"not":"an event"}\n');
    const r = readRun(a.dir);
    expect(r.problems.some((p) => p.includes('missing episode.json'))).toBe(true);
    expect(r.problems.some((p) => p.includes('events.jsonl'))).toBe(true);
  });
});

describe('hidden-data guard', () => {
  const input = legitExtension();

  it('refuses hidden expected data in the run dir while live', () => {
    const a = new RunArtifacts({ root: path.join(tmp, 'guard1'), runId: 'run-1' });
    expect(() =>
      a.writeFile('scenario.json', stableStringify({ spec: input.spec, expected: input.expected })),
    ).toThrow(HiddenDataLeakError);
    expect(() => a.writeFile('notes.txt', 'eligible_resource_ids: [RESERVE-40]')).toThrow(
      HiddenDataLeakError,
    );
    a.setLive(false);
    expect(() =>
      a.writeFile('scenario.json', stableStringify({ expected: input.expected })),
    ).not.toThrow();
  });

  it('refuses grades and report while live', () => {
    const a = new RunArtifacts({ root: path.join(tmp, 'guard2'), runId: 'run-1' });
    expect(() => a.writeGrades(gradeEpisode(input).report)).toThrow(LiveRunWriteError);
    expect(() => a.writeReportHtml('<p>x</p>')).toThrow(LiveRunWriteError);
  });

  it('always guards declared agent-reachable paths, and refuses overlap with the run dir', () => {
    const agentDir = path.join(tmp, 'agent-home');
    const a = new RunArtifacts({
      root: path.join(tmp, 'guard3'),
      runId: 'run-1',
      agentReachablePaths: [agentDir],
      live: false,
    });
    expect(a.live).toBe(false);
    const opts = { live: false, runDir: a.dir, agentReachablePaths: [agentDir] };
    expect(() =>
      assertNoHiddenLeak(path.join(agentDir, 'mcp.json'), { task: 'x', expected: {} }, opts),
    ).toThrow(HiddenDataLeakError);
    expect(() =>
      assertNoHiddenLeak(path.join(agentDir, 'mcp.json'), { task: 'x' }, opts),
    ).not.toThrow();
    expect(() =>
      assertNoHiddenLeak(path.join(a.dir, 'x.json'), { expected: {} }, opts),
    ).not.toThrow(); // not live
    expect(
      () => new RunArtifacts({ root: tmp, runId: 'run-x', agentReachablePaths: [tmp] }),
    ).toThrow(/overlaps/);
  });

  it('scans for explicit markers in any content, including events and binaries', () => {
    const a = new RunArtifacts({
      root: path.join(tmp, 'guard4'),
      runId: 'run-1',
      hiddenMarkers: ['SECRET-ANSWER-KEY'],
    });
    expect(() =>
      a.writeScreenshot('s.png', new TextEncoder().encode('xxSECRET-ANSWER-KEYxx')),
    ).toThrow(HiddenDataLeakError);
    expect(() => a.writeEvents(input.events)).not.toThrow();
  });

  it('agent-supplied request keys in events do not trip the key scan', () => {
    const a = new RunArtifacts({ root: path.join(tmp, 'guard5'), runId: 'run-1' });
    const ev = input.events.map((e) =>
      e.eventType === 'action.attempted'
        ? { ...e, payload: { ...e.payload, request: { expected: 1 } } }
        : e,
    );
    expect(() => a.writeEvents(ev)).not.toThrow();
  });
});
