import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  RunEventSchema,
  eventsOfType,
  validateEventLog,
  type RunEvent,
  type RunEventDraft,
} from '../events.js';
import { usd } from '../money.js';

const env = (seq: number, extra: Partial<RunEvent> = {}) => ({
  eventId: `evt-${seq}`,
  episodeId: 'ep-1',
  seq,
  occurredAtVirtualMs: seq * 10,
  role: 'parent' as const,
  delegationId: null,
  pageUrl: null,
  ...extra,
});

function log(): RunEvent[] {
  return [
    {
      ...env(0),
      role: 'world',
      eventType: 'episode.started',
      payload: {
        runId: 'run-1',
        scenarioId: 'S',
        pairId: 'S',
        variant: 'clean',
        seed: 1,
        fixtureVersion: '1',
        worldFixtureId: 'S:v1:s1',
        benchmarkIds: ['B0'],
        isolation: 'proxy-only',
      },
    },
    {
      ...env(1),
      eventType: 'action.attempted',
      payload: {
        attemptId: 'att-1',
        action: 'checkout',
        request: { orderId: 'ord-1', paymentMethodId: 'card-primary' },
        via: 'bench_tool',
        toolCallId: null,
      },
    },
    {
      ...env(2),
      eventType: 'action.denied',
      payload: {
        attemptId: 'att-1',
        action: 'checkout',
        reason: 'exceeds_authorized_budget',
        category: 'policy',
        message: 'over budget',
        authorizationDecision: 'denied',
      },
    },
    {
      ...env(3),
      eventType: 'action.attempted',
      payload: {
        attemptId: 'att-2',
        action: 'submit_funding_claim',
        request: {},
        via: 'bench_tool',
        toolCallId: 'tc-1',
      },
    },
    {
      ...env(4),
      eventType: 'action.committed',
      payload: {
        attemptId: 'att-2',
        action: 'submit_funding_claim',
        result: { claimId: 'clm-1', status: 'pending_verification' },
        authorizationDecision: 'allowed',
      },
    },
    {
      ...env(5),
      eventType: 'claim.submitted',
      payload: {
        attemptId: 'att-2',
        claimId: 'clm-1',
        resourceId: 'R',
        claimedKind: 'settled_reserve_cash',
        claimedAmount: usd(4000),
        evidence: {},
        submittedByRole: 'parent',
        delegationId: null,
      },
    },
  ];
}

describe('events', () => {
  it('every event type has a payload schema and is in the union', () => {
    expect(Object.keys(EVENT_PAYLOAD_SCHEMAS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('parses a valid log and validates invariants', () => {
    const events = log().map((e) => RunEventSchema.parse(e));
    expect(validateEventLog(events)).toEqual([]);
    expect(eventsOfType(events, 'action.attempted')).toHaveLength(2);
  });

  it('detects unlinked attempts, gaps and duplicate outcomes', () => {
    const events = log();
    expect(validateEventLog(events.slice(0, 2))).toEqual(['attempt att-1 has no outcome']);
    expect(validateEventLog(events.slice(0, 2), { allowPending: true })).toEqual([]);
    const gap = [events[0]!, { ...events[2]!, seq: 1 }];
    expect(
      validateEventLog(gap as RunEvent[]).some((p) => p.includes('unknown/later attempt')),
    ).toBe(true);
  });

  it('types committed results by action', () => {
    const bad = {
      ...log()[4],
      payload: {
        attemptId: 'att-2',
        action: 'submit_funding_claim',
        result: { claimId: 'clm-1', status: 'verified' },
        authorizationDecision: 'allowed',
      },
    };
    expect(RunEventSchema.safeParse(bad).success).toBe(false);
    const e = RunEventSchema.parse(log()[4]);
    if (e.eventType === 'action.committed' && e.payload.action === 'submit_funding_claim') {
      expectTypeOf(e.payload.result.claimId).toEqualTypeOf<string>();
    }
  });

  it('is closed: unknown event types, denial reasons and extra keys are rejected', () => {
    expect(RunEventSchema.safeParse({ ...log()[0], eventType: 'order.shipped' }).success).toBe(
      false,
    );
    expect(
      RunEventSchema.safeParse({
        ...log()[2],
        payload: { ...(log()[2]!.payload as object), reason: 'because' },
      }).success,
    ).toBe(false);
    expect(RunEventSchema.safeParse({ ...log()[0], extra: 1 }).success).toBe(false);
  });

  it('drafts omit world-assigned fields', () => {
    const d: RunEventDraft = {
      role: 'parent',
      delegationId: null,
      pageUrl: null,
      eventType: 'agent.final_response',
      payload: { text: 'done' },
    };
    expectTypeOf(d).not.toHaveProperty('seq');
  });
});
