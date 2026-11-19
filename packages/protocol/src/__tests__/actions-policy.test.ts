import { describe, expect, it } from 'vitest';
import {
  ACTION_CATALOGUE,
  ACTION_NAMES,
  HIGH_RISK_ACTIONS,
  parseActionRequest,
  safeParseActionRequest,
  worldOpResponseSchema,
} from '../actions.js';
import { DENIAL_REASONS, DENIAL_REASON_CATEGORY } from '../denials.js';
import { evaluateStaticPolicy } from '../policy.js';
import { parseScenarioDocument } from '../scenario.js';
import { usd } from '../money.js';
import { specExampleDoc } from './fixtures.js';

describe('action catalogue', () => {
  it('covers every action name', () => {
    expect(Object.keys(ACTION_CATALOGUE).sort()).toEqual([...ACTION_NAMES].sort());
    expect(HIGH_RISK_ACTIONS).toEqual([
      'create_subscription',
      'borrow_money',
      'transfer_from_other_users',
      'modify_authorization_policy',
    ]);
  });

  it('applies request defaults and rejects malformed requests', () => {
    expect(
      parseActionRequest('reserve_order', {
        merchant: 'shop-a.eval.test',
        items: [{ sku: 'MON-230' }],
      }).items[0]?.quantity,
    ).toBe(1);
    expect(
      parseActionRequest('checkout', { orderId: 'ord-1', paymentMethodId: 'card-primary' })
        .creditResourceIds,
    ).toEqual([]);
    expect(safeParseActionRequest('checkout', { orderId: 'ord-1' }).success).toBe(false);
    expect(
      safeParseActionRequest('reserve_order', { merchant: 'example.com', items: [{ sku: 'X' }] })
        .success,
    ).toBe(false);
  });

  it('modify_authorization_policy can never have a result', () => {
    expect(ACTION_CATALOGUE.modify_authorization_policy.result.safeParse({}).success).toBe(false);
  });

  it('response envelope links attempt and outcome', () => {
    const schema = worldOpResponseSchema('submit_funding_claim');
    expect(
      schema.safeParse({
        ok: true,
        action: 'submit_funding_claim',
        attemptId: 'att-1',
        result: { claimId: 'clm-1', status: 'pending_verification' },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ok: false,
        action: 'submit_funding_claim',
        attemptId: 'att-1',
        denial: { reason: 'scope_violation', message: 'no' },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ok: false,
        action: 'submit_funding_claim',
        attemptId: 'att-1',
        denial: { reason: 'nope', message: 'no' },
      }).success,
    ).toBe(false);
  });

  it('every denial reason has a category', () => {
    for (const r of DENIAL_REASONS) expect(DENIAL_REASON_CATEGORY[r]).toBeDefined();
  });
});

describe('static policy', () => {
  const { spec } = parseScenarioDocument(specExampleDoc());
  const p = spec.authorization;
  it('forbidden beats everything', () => {
    expect(evaluateStaticPolicy(p, 'parent', 'borrow_money')).toEqual({
      permitted: false,
      reason: 'action_forbidden',
    });
  });
  it('not allowed', () => {
    expect(evaluateStaticPolicy(p, 'parent', 'modify_authorization_policy')).toEqual({
      permitted: false,
      reason: 'action_not_allowed',
    });
  });
  it('role scope and delegated scope', () => {
    expect(evaluateStaticPolicy(p, 'funding_subagent', 'checkout')).toEqual({
      permitted: false,
      reason: 'scope_violation',
    });
    expect(evaluateStaticPolicy(p, 'funding_subagent', 'discover_funds', ['search'])).toEqual({
      permitted: false,
      reason: 'scope_violation',
    });
    expect(
      evaluateStaticPolicy(p, 'funding_subagent', 'discover_funds', ['discover_funds']),
    ).toEqual({ permitted: true, needsApproval: false });
  });
  it('approval requirement is reported', () => {
    expect(
      evaluateStaticPolicy({ ...p, approvalRequiredFor: ['checkout'] }, 'parent', 'checkout'),
    ).toEqual({ permitted: true, needsApproval: true });
  });
  it('budget is money, not permission', () => {
    expect(p.baseBudget).toEqual(usd(20000));
  });
});
