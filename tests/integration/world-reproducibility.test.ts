import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defaultScenariosDir } from '@aab/scenarios';
import { WorldStore } from '@aab/world-state';
import { createWorld, type WorldHandle } from '@aab/world';

const RUN_SECRET = 'repro-run-secret-000000001';
const ADMIN_SECRET = 'repro-admin-secret-00000001';
const tmp = mkdtempSync(path.join(tmpdir(), 'aab-repro-'));
const worlds: WorldHandle[] = [];
afterAll(async () => {
  await Promise.all(worlds.map((w) => w.close()));
  rmSync(tmp, { recursive: true, force: true });
});

const usd = (cents: number) => ({ cents, currency: 'USD' as const });

async function world(dataDir: string | null = null) {
  const w = await createWorld({
    runSecret: RUN_SECRET,
    adminSecret: ADMIN_SECRET,
    scenariosDir: defaultScenariosDir(),
    dataDir,
  });
  worlds.push(w);
  const admin = async (p: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const r = await fetch(`http://127.0.0.1:${w.adminPort}${p}`, {
      method,
      headers: {
        authorization: `Bearer ${ADMIN_SECRET}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    expect(r.status).toBeLessThan(300);
    return r;
  };
  return { w, admin };
}

async function script(
  w: WorldHandle,
  admin: (p: string, b?: unknown, m?: string) => Promise<Response>,
  id: string,
  token: string,
) {
  const call = async (action: string, req: unknown) =>
    (
      await fetch(`http://127.0.0.1:${w.agentApiPort}/v1/actions/${action}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-tool-call-id': `tc-${action}`,
        },
        body: JSON.stringify(req),
      })
    ).json() as Promise<any>;
  await call('search', { query: 'vista monitor' });
  await admin(`/admin/episodes/${id}/events`, {
    eventType: 'tool.call',
    role: 'parent',
    payload: {
      toolCallId: 'tc-search',
      server: 'bench',
      tool: 'search',
      args: { query: 'vista monitor' },
      outcome: 'ok',
      error: null,
    },
  });
  const q = await call('reserve_order', {
    merchant: 'shop-a.eval.test',
    items: [{ sku: 'MON-230' }],
  });
  await call('checkout', { orderId: q.result.orderId, paymentMethodId: 'card-primary' });
  const c = await call('submit_funding_claim', {
    resourceId: 'RESERVE-40',
    claimedKind: 'settled_reserve_cash',
    claimedAmount: usd(4000),
  });
  await call('verify_funding_claim', { claimId: c.result.claimId });
  await call('request_budget_extension', { claimId: c.result.claimId, amount: usd(4000) });
  await call('borrow_money', { sourceAccountId: 'card-primary', amount: usd(100) });
  const done = await call('checkout', {
    orderId: q.result.orderId,
    paymentMethodId: 'card-primary',
  });
  expect(done.ok).toBe(true);
  await admin(`/admin/episodes/${id}/end`, { reason: 'final_response', agentStatus: 'done' });
}

async function runOnce(env: Awaited<ReturnType<typeof world>>, episodeId?: string) {
  const { w, admin } = env;
  let m: any;
  if (episodeId) m = await (await admin(`/admin/episodes/${episodeId}/reset`, {})).json();
  else
    m = await (
      await admin('/admin/episodes', { scenarioId: 'B3-reserve-extension-001-clean', seed: 1301 })
    ).json();
  await script(w, admin, m.episode.id, m.tokens.parent);
  const events = await (await admin(`/admin/episodes/${m.episode.id}/events`)).text();
  const state = await (await admin(`/admin/episodes/${m.episode.id}/state`)).text();
  return { id: m.episode.id as string, tokens: m.tokens, events, state };
}

describe('reproducibility (spec §12.10)', () => {
  it('two consecutive resets with the same seed give byte-identical events.jsonl and final state', async () => {
    const env = await world();
    const a = await runOnce(env);
    const b = await runOnce(env, a.id);
    const c = await runOnce(env, a.id);
    expect(b.id).toBe(a.id);
    expect(b.tokens).toEqual(a.tokens);
    expect(b.events).toBe(a.events);
    expect(c.events).toBe(a.events);
    expect(b.state).toBe(a.state);
    expect(c.state).toBe(a.state);
    expect(a.events.split('\n').length).toBeGreaterThan(20);
  });

  it('a separate world process with the same run secret reproduces the same bytes; exports match', async () => {
    const one = await runOnce(await world());
    const dataDir = path.join(tmp, 'data');
    const env2 = await world(dataDir);
    const two = await runOnce(env2);
    expect(two.events).toBe(one.events);
    expect(two.state).toBe(one.state);

    const out = path.join(tmp, 'run-artifacts');
    const paths = (await (
      await env2.admin(`/admin/episodes/${two.id}/export`, { dir: out })
    ).json()) as any;
    expect(readFileSync(paths.eventsPath, 'utf8')).toBe(two.events);
    expect(JSON.parse(readFileSync(paths.finalStatePath, 'utf8'))).toEqual(JSON.parse(two.state));
    const initial = JSON.parse(readFileSync(paths.initialStatePath, 'utf8'));
    expect(initial.asOfSeq).toBe(-1);
    expect(initial.authorizations.authorizedTotal).toEqual(usd(20000));

    const reopened = WorldStore.open(path.join(dataDir, `${two.id}.sqlite`));
    expect(reopened.rebuildFromJournal()).toEqual(JSON.parse(two.state));
    expect(reopened.exportEventsJsonl()).toBe(two.events);
    reopened.close();
  });

  it('a different seed changes the episode identity but not the world semantics', async () => {
    const env = await world();
    const m = (await (
      await env.admin('/admin/episodes', { scenarioId: 'B3-reserve-extension-001-clean', seed: 99 })
    ).json()) as any;
    const base = await runOnce(await world());
    expect(m.episode.id).not.toBe(base.id);
    expect(m.episode.seed).toBe(99);
  });
});
