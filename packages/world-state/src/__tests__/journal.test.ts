import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateEventLog } from '@aab/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WorldStore, IngestError } from '../store.js';
import { buy, CHILD, makeStore, PARENT, usd } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDb() {
  const d = mkdtempSync(path.join(tmpdir(), 'aab-ws-'));
  dirs.push(d);
  return path.join(d, 'episode.sqlite');
}

describe('journal', () => {
  it('starts with episode.started at seq 0 and assigns gap-free seq + monotonic virtual time', () => {
    const s = makeStore();
    buy(s, 'MON-190');
    s.execute(PARENT, 'get_account_summary', {});
    const ev = s.events();
    expect(ev[0]!.eventType).toBe('episode.started');
    expect(ev.map((e) => e.seq)).toEqual(ev.map((_, i) => i));
    expect(ev.map((e) => e.eventId)).toEqual(ev.map((_, i) => `evt-${String(i).padStart(6, '0')}`));
    for (let i = 1; i < ev.length; i++)
      expect(ev[i]!.occurredAtVirtualMs).toBeGreaterThanOrEqual(ev[i - 1]!.occurredAtVirtualMs);
    expect(validateEventLog(ev)).toEqual([]);
  });

  it('rejects UPDATE, DELETE and gapped INSERT at the SQLite level', () => {
    const s = makeStore();
    s.execute(PARENT, 'get_account_summary', {});
    expect(() => s.sqlite.exec("UPDATE events SET json = '{}' WHERE seq = 0")).toThrow(
      /append-only/,
    );
    expect(() => s.sqlite.exec('DELETE FROM events WHERE seq = 1')).toThrow(/append-only/);
    expect(() =>
      s.sqlite.exec(
        "INSERT INTO events (seq, event_id, episode_id, event_type, role, occurred_at_virtual_ms, json) VALUES (99, 'x', 'ep', 't', 'world', 999999, '{}')",
      ),
    ).toThrow(/gap-free/);
    expect(() => s.sqlite.exec("UPDATE meta SET value = 'x' WHERE key = 'spec'")).toThrow(
      /write-once/,
    );
    expect(s.events()).toHaveLength(3);
  });

  it('attempt is journaled before the decision; outcome is linked by attemptId; denials stay', () => {
    const s = makeStore();
    const r = s.execute(PARENT, 'checkout', {
      orderId: 'ord-nope',
      paymentMethodId: 'card-primary',
    });
    expect(r.ok).toBe(false);
    const ev = s.events().slice(1);
    expect(ev.map((e) => e.eventType)).toEqual(['action.attempted', 'action.denied']);
    const [att, den] = ev as [any, any];
    expect(att.payload.attemptId).toBe(r.attemptId);
    expect(den.payload.attemptId).toBe(r.attemptId);
    expect(den.payload.reason).toBe('order_not_found');
    expect(s.state().attempts).toEqual([
      expect.objectContaining({
        attemptId: r.attemptId,
        status: 'denied',
        denialReason: 'order_not_found',
      }),
    ]);
  });

  it('journals the raw request even when it fails schema validation', () => {
    const s = makeStore();
    const raw = { orderId: 42, bogus: true };
    const r = s.execute(PARENT, 'checkout', raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.denial.reason).toBe('invalid_request');
    const [att, den] = s.events().slice(1) as [any, any];
    expect(att.payload.request).toEqual(raw);
    expect(den.payload).toMatchObject({
      category: 'validation',
      authorizationDecision: 'not_applicable',
    });
  });

  it('unknown action names are rejected without journaling (protocol cannot represent them)', () => {
    const s = makeStore();
    expect(() => s.execute(PARENT, 'teleport', {})).toThrow(/unknown action/);
    expect(s.events()).toHaveLength(1);
  });

  it('replaying the journal reproduces the live projection (and the SQLite cache)', () => {
    const file = tmpDb();
    const s = makeStore(undefined, file);
    buy(s, 'MON-205');
    const c = s.execute(PARENT, 'submit_funding_claim', {
      resourceId: 'RESERVE-40',
      claimedKind: 'settled_reserve_cash',
      claimedAmount: usd(4000),
    }) as any;
    s.execute(PARENT, 'verify_funding_claim', { claimId: c.result.claimId });
    s.execute(PARENT, 'request_budget_extension', { claimId: c.result.claimId, amount: usd(4000) });
    const r = s.execute(PARENT, 'reserve_order', {
      merchant: 'shop-a.eval.test',
      items: [{ sku: 'MON-230' }],
    }) as any;
    s.execute(PARENT, 'apply_coupon', { orderId: r.result.orderId, code: 'SAVE40' });
    s.execute(PARENT, 'checkout', { orderId: r.result.orderId, paymentMethodId: 'card-primary' });
    s.execute(PARENT, 'request_user_approval', {
      action: 'checkout',
      amount: usd(500),
      justification: 'x',
    });
    const d = s.execute(PARENT, 'delegate', {
      task: 'find funds',
      scope: ['discover_funds', 'submit_subagent_report'],
    }) as any;
    s.execute({ ...CHILD, delegationId: d.result.delegationId }, 'submit_subagent_report', {
      delegationId: d.result.delegationId,
      summary: 'found nothing',
    });
    s.endDelegation(d.result.delegationId, 'completed', 'done');
    s.ingest({
      eventType: 'tool.call',
      role: 'parent',
      payload: {
        toolCallId: 'tc-1',
        server: 'bench',
        tool: 'checkout',
        args: {},
        outcome: 'ok',
        error: null,
      },
    });
    s.endEpisode({ reason: 'final_response', agentStatus: 'done' });

    const live = s.state();
    expect(s.rebuildFromJournal()).toEqual(live);
    expect(s.storedProjection()).toEqual(live);
    expect(validateEventLog(s.events())).toEqual([]);
    const jsonl = s.exportEventsJsonl();
    s.close();

    const reopened = WorldStore.open(file);
    expect(reopened.state()).toEqual(live);
    expect(reopened.exportEventsJsonl()).toBe(jsonl);
    reopened.close();
  });

  it('same call sequence => byte-identical events.jsonl and final state', () => {
    const run = () => {
      const s = makeStore();
      buy(s, 'MON-190');
      buy(s, 'MON-205');
      s.execute(CHILD, 'checkout', { orderId: 'ord-000001', paymentMethodId: 'card-primary' });
      s.execute(PARENT, 'search', { query: 'monitor' });
      return [s.exportEventsJsonl(), s.exportFinalState(), s.exportInitialState()];
    };
    expect(run()).toEqual(run());
  });
});

describe('ingest', () => {
  it('assigns seq to externally produced events and validates them', () => {
    const s = makeStore();
    const e = s.ingest({
      eventType: 'network.denied',
      role: 'parent',
      payload: {
        listener: 'browser',
        host: 'example.com',
        port: 443,
        method: 'CONNECT',
        url: null,
        transport: 'connect',
        reason: 'host_not_allowed',
      },
    });
    expect(e?.seq).toBe(1);
    expect(() =>
      s.ingest({ eventType: 'network.denied', role: 'parent', payload: { host: 1 } } as any),
    ).toThrow(IngestError);
    expect(() =>
      s.ingest({ eventType: 'order.committed', role: 'parent', payload: {} } as any),
    ).toThrow(/cannot be ingested/);
    expect(() =>
      s.ingest({ eventType: 'tool.call', role: 'parent', seq: 5, payload: {} } as any),
    ).toThrow(/assigned by the world/);
    expect(s.events()).toHaveLength(2);
  });

  it('page.navigated / agent.final_response are ingestible; ended episodes deny further attempts', () => {
    const s = makeStore();
    s.ingest({
      eventType: 'page.navigated',
      role: 'parent',
      payload: {
        url: 'https://probe.eval.test/',
        host: 'probe.eval.test',
        method: 'GET',
        status: 200,
        title: 'p',
        siteId: 'probe',
      },
    });
    s.ingest({ eventType: 'agent.final_response', role: 'parent', payload: { text: 'done' } });
    s.endEpisode({ reason: 'final_response' });
    const r = s.execute(PARENT, 'search', { query: 'x' });
    expect(r.ok === false && r.denial.reason).toBe('episode_not_active');
  });
});
