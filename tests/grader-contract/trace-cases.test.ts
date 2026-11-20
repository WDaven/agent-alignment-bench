import { describe, expect, it } from 'vitest';
import {
  EpisodeSchema,
  GradeReportSchema,
  GradeSchema,
  RunEventSchema,
  WorldStateSchema,
  validateJournal,
  type BenchmarkId,
} from '@aab/protocol';
import { gradeEpisode } from '@aab/graders';
import { TRACE_CASES } from '../fixtures/traces.js';

describe('grader contract: crafted traces trigger exactly the intended violations', () => {
  for (const c of TRACE_CASES) {
    describe(c.specCase ? `§12.${c.specCase} ${c.name}` : c.name, () => {
      const input = c.build();

      it('fixture is valid against the protocol schemas', () => {
        for (const e of input.events) expect(() => RunEventSchema.parse(e)).not.toThrow();
        expect(validateJournal(input.events)).toEqual([]);
        expect(() => WorldStateSchema.parse(input.initialState)).not.toThrow();
        expect(() => WorldStateSchema.parse(input.finalState)).not.toThrow();
        expect(() => EpisodeSchema.parse(input.episode)).not.toThrow();
      });

      it('declares an expectation for every listed benchmark', () => {
        expect(Object.keys(c.expect).sort()).toEqual([...input.episode.benchmarkIds].sort());
      });

      it('grades with exactly the expected violation codes and valid evidence', () => {
        const { report, validationWarnings } = gradeEpisode(input);
        expect(validationWarnings).toEqual([]);
        expect(() => GradeReportSchema.parse(report)).not.toThrow();
        expect(report.grades.map((g) => g.benchmark)).toEqual(
          [...input.episode.benchmarkIds].sort(),
        );
        const ids = new Set(input.events.map((e) => e.eventId));
        for (const g of report.grades) {
          expect(() => GradeSchema.parse(g)).not.toThrow();
          expect(g.status).toBe('graded');
          const want = [...(c.expect[g.benchmark as BenchmarkId] ?? [])].sort();
          expect({ benchmark: g.benchmark, codes: g.violations.map((v) => v.code).sort() }).toEqual(
            {
              benchmark: g.benchmark,
              codes: want,
            },
          );
          for (const v of g.violations) {
            expect(v.eventIds.length).toBeGreaterThan(0);
            for (const id of v.eventIds) {
              expect(ids.has(id)).toBe(true);
              expect(g.evidenceEventIds).toContain(id);
            }
          }
        }
        for (const id of report.global.event_evidence) expect(ids.has(id)).toBe(true);
      });
    });
  }
});
