import { describe, expect, it } from 'vitest';
import { AgentEpisodeViewSchema, EpisodeSchema, episodeFromSpec } from '../episode.js';
import { parseScenarioDocument } from '../scenario.js';
import { WorldStateSchema, type WorldState } from '../world-state.js';
import { usd } from '../money.js';
import { specExampleDoc } from './fixtures.js';

describe('episode', () => {
  const { spec } = parseScenarioDocument(specExampleDoc());
  it('builds a valid episode from a spec', () => {
    const ep = episodeFromSpec(spec, { episodeId: 'ep-1', runId: 'run-1' });
    expect(EpisodeSchema.parse(ep).worldFixtureId).toBe('B4-unverified-funding-001:v1:s1042');
  });
  it('agent view cannot carry variant or expected data', () => {
    const view = {
      episodeId: 'ep-1',
      role: 'parent',
      task: spec.userTask,
      delegationId: null,
      availableActions: ['search'],
      maxSteps: 10,
      maxWallMs: 60000,
    };
    expect(AgentEpisodeViewSchema.safeParse(view).success).toBe(true);
    expect(AgentEpisodeViewSchema.safeParse({ ...view, variant: 'adversarial' }).success).toBe(
      false,
    );
  });
});

describe('world state', () => {
  it('accepts an initial projection built from the fixture', () => {
    const { spec } = parseScenarioDocument(specExampleDoc());
    const asState = (r: (typeof spec.world.resources)[number]) =>
      ({ ...r, usedAmount: usd(0), status: r.available ? 'available' : 'unavailable' }) as const;
    const state: WorldState = {
      episodeId: 'ep-1',
      lifecycle: {
        status: 'active',
        endReason: null,
        endedAtSeq: null,
        stepsUsed: 0,
        unknownActionAttempts: 0,
      },
      asOfSeq: -1,
      virtualNowMs: 0,
      accounts: spec.world.accounts,
      funds: spec.world.resources.map(asState),
      credits: [],
      coupons: [],
      refunds: [],
      orders: [],
      subscriptions: [],
      approvals: [],
      delegations: [],
      claims: [],
      authorizations: {
        baseBudget: usd(20000),
        maxAdditionalBudget: usd(4000),
        extensions: [],
        extensionsTotal: usd(0),
        authorizedTotal: usd(20000),
        committedSpend: usd(0),
        remaining: usd(20000),
      },
      attempts: [],
      inventory: [{ sku: 'MON-230', merchant: 'shop-a.eval.test', inStock: true }],
    };
    expect(WorldStateSchema.safeParse(state).success).toBe(true);
  });
});
