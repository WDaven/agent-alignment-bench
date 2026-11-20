import { describe, expect, it } from 'vitest';
import { GradeSchema, VIOLATION_CODES, VIOLATION_DEFAULT_SEVERITY } from '../grade.js';
import {
  DEFAULT_PROXY_POLICY,
  ProxyRuleSchema,
  TRUSTED_HEADERS,
  decideProxyAction,
} from '../proxy.js';
import { isEvalHost } from '../common.js';

describe('grades', () => {
  const base = {
    benchmark: 'B1',
    status: 'graded',
    violations: [],
    evidenceEventIds: [],
    trapOutcomes: [],
    graderVersion: '1',
    notes: [],
  } as const;
  it('accepts only the benchmark’s metric names', () => {
    expect(
      GradeSchema.safeParse({ ...base, metrics: { unauthorized_action_attempt_rate: 0.5 } })
        .success,
    ).toBe(true);
    expect(GradeSchema.safeParse({ ...base, metrics: { attack_success_rate: 0.5 } }).success).toBe(
      false,
    );
  });
  it('violations need evidence', () => {
    const v = {
      code: 'budget_exceeded_attempted',
      severity: 'medium',
      eventIds: [],
      executed: false,
      message: '',
    };
    expect(GradeSchema.safeParse({ ...base, metrics: {}, violations: [v] }).success).toBe(false);
    expect(
      GradeSchema.safeParse({ ...base, metrics: {}, violations: [{ ...v, eventIds: ['evt-2'] }] })
        .success,
    ).toBe(true);
  });
  it('every violation code has a default severity', () => {
    for (const c of VIOLATION_CODES) expect(VIOLATION_DEFAULT_SEVERITY[c]).toBeDefined();
  });
});

describe('proxy policy', () => {
  it('intercepts eval.test, tunnels model APIs, denies the rest', () => {
    expect(decideProxyAction(DEFAULT_PROXY_POLICY, 'shop-a.eval.test', 443, 'connect')).toBe(
      'intercept',
    );
    expect(decideProxyAction(DEFAULT_PROXY_POLICY, 'search.eval.test', 80, 'http')).toBe(
      'intercept',
    );
    expect(decideProxyAction(DEFAULT_PROXY_POLICY, 'api.anthropic.com', 443, 'connect')).toBe(
      'passthrough',
    );
    expect(decideProxyAction(DEFAULT_PROXY_POLICY, 'api.anthropic.com', 8443, 'connect')).toBe(
      'deny',
    );
    expect(decideProxyAction(DEFAULT_PROXY_POLICY, 'www.google.com', 443, 'connect')).toBe('deny');
    expect(decideProxyAction(DEFAULT_PROXY_POLICY, 'evileval.test', 443, 'connect')).toBe('deny');
  });
  it('refuses intercept rules outside eval.test', () => {
    expect(
      ProxyRuleSchema.safeParse({
        match: { type: 'exact', host: 'api.openai.com' },
        action: 'intercept',
        ports: null,
      }).success,
    ).toBe(false);
  });
  it('exposes trusted header names', () => {
    expect(TRUSTED_HEADERS.episode).toBe('x-bench-episode');
    expect(TRUSTED_HEADERS.role).toBe('x-bench-role');
    expect(isEvalHost('a.eval.test')).toBe(true);
    expect(isEvalHost('eval.test.evil.com')).toBe(false);
  });
});
