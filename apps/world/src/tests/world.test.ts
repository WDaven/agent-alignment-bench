import { request as httpRequest } from 'node:http';
import { ACTION_NAMES, PROBE_HOST, TRUSTED_HEADERS, type RunEvent } from '@aab/protocol';
import { defaultScenariosDir, ScenarioCatalog } from '@aab/scenarios';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, type WorldHandle, type WorldSitePlugin } from '../index.js';

const RUN_SECRET = 'world-test-run-secret-000';
const ADMIN_SECRET = 'world-test-admin-secret-000';
const DIR = defaultScenariosDir();
const catalog = ScenarioCatalog.loadDir(DIR);

const testPlugin: WorldSitePlugin = {
  id: 'test-shop',
  hosts: ['test-a.eval.test'],
  register(app, ctx) {
    app.get('/', async (_req, reply) => {
      reply.type('text/html');
      return '<html><head><title>Test shop</title></head><body>shop</body></html>';
    });
    app.post('/buy', async (req) => {
      const scope = ctx.resolve({
        headers: req.headers,
        url: `https://test-a.eval.test${req.url}`,
        method: req.method,
      });
      const traps = scope.fixture.traps;
      for (const t of traps)
        await scope.traps.recordExposure(t.id, {
          url: 'https://test-a.eval.test/buy',
          exposureKind: 'rendered',
        });
      for (const t of traps)
        await scope.traps.recordExposure(t.id, {
          url: 'https://test-a.eval.test/buy',
          exposureKind: 'rendered',
        });
      const r = await scope.actions.call('reserve_order', {
        merchant: 'shop-a.eval.test',
        items: [{ sku: 'MON-230' }],
      });
      return { r, trapCount: traps.length, seedFor: typeof ctx.seedFor(scope.episodeId) };
    });
  },
};

let w: WorldHandle;
const url = (port: number, p: string) => `http://127.0.0.1:${port}${p}`;
const admin = (p: string, init: RequestInit = {}) =>
  fetch(url(w.adminPort, p), {
    ...init,
    headers: {
      authorization: `Bearer ${ADMIN_SECRET}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
async function newEpisode(scenarioId: string, extra: Record<string, unknown> = {}) {
  const r = await admin('/admin/episodes', {
    method: 'POST',
    body: JSON.stringify({ scenarioId, ...extra }),
  });
  expect(r.status).toBe(201);
  return (await r.json()) as {
    episode: { id: string; seed: number };
    tokens: { parent: string; funding_subagent: string };
  };
}
function site(
  p: string,
  host: string,
  headers: Record<string, string> = {},
  init: { method?: string } = {},
) {
  return new Promise<{ status: number; text(): Promise<string>; json(): Promise<any> }>(
    (resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: w.sitePort,
          path: p,
          method: init.method ?? 'GET',
          headers: { ...headers, host },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode ?? 0,
              text: async () => body,
              json: async () => JSON.parse(body),
            });
          });
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}
const agent = (token: string, action: string, body: unknown) =>
  fetch(url(w.agentApiPort, `/v1/actions/${action}`), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
async function events(id: string): Promise<RunEvent[]> {
  const t = await (await admin(`/admin/episodes/${id}/events`)).text();
  return t
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as RunEvent);
}

beforeAll(async () => {
  w = await createWorld({
    runSecret: RUN_SECRET,
    adminSecret: ADMIN_SECRET,
    scenariosDir: DIR,
    plugins: [testPlugin],
  });
});
afterAll(async () => {
  await w?.close();
});

describe('listeners', () => {
  it('admin API lives on its own 127.0.0.1 listener and needs its secret', async () => {
    expect(new Set([w.agentApiPort, w.sitePort, w.adminPort]).size).toBe(3);
    expect((await fetch(url(w.adminPort, '/admin/episodes'))).status).toBe(401);
    expect(
      (
        await fetch(url(w.adminPort, '/admin/episodes'), {
          headers: { authorization: `Bearer ${RUN_SECRET}` },
        })
      ).status,
    ).toBe(401);
    expect((await admin('/admin/episodes')).status).toBe(200);
  });

  it('admin routes are not reachable via the agent or site listeners', async () => {
    const { episode } = await newEpisode('B0-clean-purchase-001', { episodeId: 'ep-iso' });
    const paths = [
      '/admin/episodes',
      `/admin/episodes/${episode.id}`,
      `/admin/episodes/${episode.id}/state`,
      `/admin/episodes/${episode.id}/events`,
    ];
    for (const p of paths) {
      const auth = { authorization: `Bearer ${ADMIN_SECRET}` };
      const a = await fetch(url(w.agentApiPort, p), { headers: auth });
      expect(a.status, p).toBe(404);
      const s = await site(p, PROBE_HOST, {
        ...auth,
        [TRUSTED_HEADERS.episode]: episode.id,
        [TRUSTED_HEADERS.role]: 'parent',
      });
      expect(s.status, p).toBe(404);
      const body = await s.text();
      expect(body).not.toContain('"tokens"');
      const post = await fetch(url(w.agentApiPort, '/admin/episodes'), {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ scenarioId: 'B0-clean-purchase-001' }),
      });
      expect(post.status).toBe(404);
    }
  });

  it('admin materialize refuses a spec carrying `expected`', async () => {
    const g = catalog.getForGrader('B0-clean-purchase-001');
    const r = await admin('/admin/episodes', {
      method: 'POST',
      body: JSON.stringify({ spec: { ...g.spec, expected: g.expected } }),
    });
    expect(r.status).toBe(400);
  });
});

describe('agent API', () => {
  it('rejects missing/invalid tokens without journaling', async () => {
    const { episode } = await newEpisode('B0-clean-purchase-001', { episodeId: 'ep-auth' });
    const before = (await events(episode.id)).length;
    expect((await agent('nope', 'search', { query: 'x' })).status).toBe(401);
    expect(
      (await fetch(url(w.agentApiPort, '/v1/actions/search'), { method: 'POST' })).status,
    ).toBe(401);
    expect((await events(episode.id)).length).toBe(before);
  });

  it('journals malformed JSON as the raw attempt, then denies invalid_request', async () => {
    const { episode, tokens } = await newEpisode('B0-clean-purchase-001', {
      episodeId: 'ep-badjson',
    });
    const r = await agent(tokens.parent, 'checkout', '{"orderId": ');
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j).toMatchObject({ ok: false, denial: { reason: 'invalid_request' } });
    const ev = await events(episode.id);
    const att = ev.find((e) => e.eventType === 'action.attempted') as Extract<
      RunEvent,
      { eventType: 'action.attempted' }
    >;
    expect(att.payload.request).toBe('{"orderId": ');
    expect(att.payload.via).toBe('bench_tool');
  });

  it('exposes one route per action and the caller’s episode view', async () => {
    const { tokens } = await newEpisode('B0-clean-purchase-001', { episodeId: 'ep-routes' });
    for (const a of ACTION_NAMES) expect((await agent(tokens.parent, a, {})).status, a).toBe(200);
    const v = (await (
      await fetch(url(w.agentApiPort, '/v1/episode'), {
        headers: { authorization: `Bearer ${tokens.funding_subagent}` },
      })
    ).json()) as any;
    expect(v).toMatchObject({ role: 'funding_subagent', delegationId: null });
    expect(v.availableActions).not.toContain('checkout');
  });

  it('delegation-bound child tokens act inside the granted scope', async () => {
    const { episode, tokens } = await newEpisode('B4-subagent-scope-001-clean', {
      episodeId: 'ep-dlg',
    });
    const d = (await (
      await agent(tokens.parent, 'delegate', {
        task: 'find reserve',
        scope: ['discover_funds', 'submit_funding_claim', 'submit_subagent_report'],
      })
    ).json()) as any;
    expect(d.ok).toBe(true);
    const t = (await (
      await admin(`/admin/episodes/${episode.id}/delegations/${d.result.delegationId}/token`, {
        method: 'POST',
      })
    ).json()) as any;
    expect(t.view).toMatchObject({ delegationId: d.result.delegationId, task: 'find reserve' });
    expect(((await (await agent(t.token, 'discover_funds', {})).json()) as any).ok).toBe(true);
    expect(
      ((await (await agent(t.token, 'search', { query: 'x' })).json()) as any).denial.reason,
    ).toBe('scope_violation');
    const ev = await events(episode.id);
    expect(
      ev.filter((e) => e.delegationId === d.result.delegationId).length,
    ).toBeGreaterThanOrEqual(4);
  });
});

describe('site host', () => {
  it('probe serves host/role/episode and /whoami, and journals page.navigated', async () => {
    const { episode } = await newEpisode('B0-clean-purchase-001', { episodeId: 'ep-probe' });
    const h = { [TRUSTED_HEADERS.episode]: episode.id, [TRUSTED_HEADERS.role]: 'parent' };
    const who = await (await site('/whoami', PROBE_HOST, h)).json();
    expect(who).toEqual({
      host: PROBE_HOST,
      episodeId: episode.id,
      role: 'parent',
      delegationId: null,
    });
    const page = await (await site('/', `${PROBE_HOST}:443`, h)).text();
    expect(page).toContain(episode.id);
    expect(page).toContain('parent');
    const nav = (await events(episode.id)).filter((e) => e.eventType === 'page.navigated') as any[];
    expect(nav.map((e) => [e.payload.url, e.payload.status, e.payload.siteId, e.role])).toEqual([
      [`https://${PROBE_HOST}/whoami`, 200, 'probe', 'parent'],
      [`https://${PROBE_HOST}/`, 200, 'probe', 'parent'],
    ]);
    expect(nav[1].payload.title).toBe('Bench probe');
  });

  it('identity comes only from trusted headers; unidentified requests are refused', async () => {
    expect((await site('/whoami', PROBE_HOST)).status).toBe(403);
    expect(
      (
        await site('/whoami', PROBE_HOST, {
          [TRUSTED_HEADERS.episode]: 'ep-nope',
          [TRUSTED_HEADERS.role]: 'parent',
        })
      ).status,
    ).toBe(403);
    const { episode } = await newEpisode('B0-clean-purchase-001', { episodeId: 'ep-hdr' });
    expect(
      (
        await site('/whoami', PROBE_HOST, {
          [TRUSTED_HEADERS.episode]: episode.id,
          [TRUSTED_HEADERS.role]: 'world',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await site('/whoami', PROBE_HOST, {
          [TRUSTED_HEADERS.episode]: episode.id,
          [TRUSTED_HEADERS.role]: 'parent',
          [TRUSTED_HEADERS.delegation]: 'dlg-x',
        })
      ).status,
    ).toBe(403);
  });

  it('dispatches by Host; unknown hosts get a 404 page (journaled with siteId null)', async () => {
    const { episode } = await newEpisode('B2-coupon-semantics-001-adv', { episodeId: 'ep-hosts' });
    const h = { [TRUSTED_HEADERS.episode]: episode.id, [TRUSTED_HEADERS.role]: 'parent' };
    expect(await (await site('/', 'test-a.eval.test', h)).text()).toContain('Test shop');
    expect(await (await site('/', PROBE_HOST, h)).text()).toContain('Bench probe');
    expect((await site('/whoami', 'test-a.eval.test', h)).status).toBe(404);
    const nf = await site('/', 'nowhere.eval.test', h);
    expect(nf.status).toBe(404);
    expect(await nf.text()).toContain('404');
    const nav = (await events(episode.id)).filter((e) => e.eventType === 'page.navigated') as any[];
    expect(nav.map((e) => [e.payload.host, e.payload.siteId])).toEqual([
      ['test-a.eval.test', 'test-shop'],
      [PROBE_HOST, 'probe'],
      ['test-a.eval.test', null],
      ['nowhere.eval.test', null],
    ]);
  });

  it('plugins act through the role-bound ops client and the trap recorder (idempotent)', async () => {
    const { episode } = await newEpisode('B2-coupon-semantics-001-adv', { episodeId: 'ep-plugin' });
    const h = { [TRUSTED_HEADERS.episode]: episode.id, [TRUSTED_HEADERS.role]: 'parent' };
    const r = await (await site('/buy', 'test-a.eval.test', h, { method: 'POST' })).json();
    expect(r.trapCount).toBe(0);
    expect(r.r.ok).toBe(true);
    const ev = await events(episode.id);
    const att = ev.find((e) => e.eventType === 'action.attempted') as any;
    expect(att.payload.via).toBe('site');
  });
});

describe('leakage (spec §12.9)', () => {
  it('no agent/site endpoint exposes expected values, grader data, other tokens, secrets or the seed', async () => {
    const id = 'B4-unverified-funding-001';
    const g = catalog.getForGrader(id);
    const Seed = 987654321;
    const { episode, tokens } = await newEpisode(id, { seed: Seed, episodeId: 'ep-leak' });
    const forbidden = [
      String(Seed),
      ADMIN_SECRET,
      RUN_SECRET,
      tokens.funding_subagent,
      'compliantPurchasePossible',
      'authorizedMax',
      'prohibitedResourceIds',
      'eligibleResourceIds',
      'attackerGoal',
      'meetsRequirements',
      g.spec.id,
      ...g.expected.traps.flatMap((t) => [t.attackerGoal, t.permissibleBehavior]),
    ];
    const bodies: string[] = [];
    const h = { [TRUSTED_HEADERS.episode]: episode.id, [TRUSTED_HEADERS.role]: 'parent' };
    for (const p of ['/', '/whoami', '/admin/episodes', '/v1/episode', '/expected', '/seed']) {
      bodies.push(await (await site(p, PROBE_HOST, h)).text());
      bodies.push(await (await site(p, 'shop-a.eval.test', h)).text());
    }
    bodies.push(
      await (
        await fetch(url(w.agentApiPort, '/v1/episode'), {
          headers: { authorization: `Bearer ${tokens.parent}` },
        })
      ).text(),
    );
    for (const a of ACTION_NAMES) bodies.push(await (await agent(tokens.parent, a, {})).text());
    bodies.push(
      await (await agent(tokens.parent, 'search', { query: 'monitor reserve cashback' })).text(),
    );
    bodies.push(await (await agent(tokens.parent, 'discover_funds', {})).text());
    bodies.push(
      await (
        await agent(tokens.parent, 'reserve_order', {
          merchant: 'shop-a.eval.test',
          items: [{ sku: 'MON-230' }],
        })
      ).text(),
    );
    bodies.push(await (await agent(tokens.parent, 'get_account_summary', {})).text());
    bodies.push(await (await fetch(url(w.agentApiPort, '/admin/episodes/ep-leak/state'))).text());
    const all = bodies.join('\n');
    for (const f of forbidden) expect(all, `leaked ${f}`).not.toContain(f);
    expect(await (await admin(`/admin/episodes/${episode.id}`)).text()).toContain(
      tokens.funding_subagent,
    );
  });
});
