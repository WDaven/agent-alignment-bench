import {
  ACTION_CATALOGUE,
  DENIAL_REASON_CATEGORY,
  evaluateStaticPolicy,
  type ActionName,
  type AgentRole,
  type AuthorizationPolicy,
  type DenialReason,
  type WorldState,
} from '@aab/protocol';
import { findApplicableApproval } from './projection.js';

/** Who is acting. A child agent bound to a delegation carries its delegationId. */
export interface Actor {
  role: AgentRole;
  delegationId: string | null;
}

export interface Denied {
  ok: false;
  reason: DenialReason;
  message: string;
  authorizationDecision: 'allowed' | 'denied' | 'not_applicable';
}

export type PolicyDecision = { ok: true; approvalId: string | null } | Denied;

/**
 * `authorizationDecision` for a denial (protocol: `denied` for policy denials, `allowed` when
 * policy passed but canonical state made it fail, `not_applicable` for validation/system and
 * for reads).
 */
export function denial(action: ActionName, reason: DenialReason, message: string): Denied {
  const cat = DENIAL_REASON_CATEGORY[reason];
  const authorizationDecision =
    cat === 'policy'
      ? 'denied'
      : cat === 'world_state' && ACTION_CATALOGUE[action].class !== 'read'
        ? 'allowed'
        : 'not_applicable';
  return { ok: false, reason, message, authorizationDecision };
}

/**
 * Pure policy engine, protocol steps 2–5 for one actor, evaluated at action time against the
 * CURRENT projection:
 *   - delegation binding (child must act inside an active delegation it belongs to),
 *   - forbidden / not allowed / role scope / delegated scope (protocol `evaluateStaticPolicy`),
 *   - approval-required (single-use approval of the same role for the same action).
 *
 * Checkout's approval is resolved by the checkout handler (it needs the order and amount), so
 * for `checkout` this returns `approvalId: null` even when approval is required.
 */
export function evaluatePolicy(
  policy: AuthorizationPolicy,
  state: WorldState,
  actor: Actor,
  action: ActionName,
): PolicyDecision {
  let delegatedScope: readonly ActionName[] | undefined;
  if (actor.delegationId) {
    const d = state.delegations.find((x) => x.delegationId === actor.delegationId);
    if (!d)
      return denial(action, 'delegation_not_found', `unknown delegation ${actor.delegationId}`);
    if (d.childRole !== actor.role)
      return denial(action, 'scope_violation', 'delegation belongs to a different role');
    if (d.status !== 'active')
      return denial(action, 'delegation_not_active', `delegation ${d.delegationId} is ${d.status}`);
    delegatedScope = d.grantedScope;
  }
  const s = evaluateStaticPolicy(policy, actor.role, action, delegatedScope);
  if (!s.permitted) {
    const msg =
      s.reason === 'action_forbidden'
        ? `${action} is forbidden by the user's policy`
        : s.reason === 'action_not_allowed'
          ? `${action} is not allowed by the user's policy`
          : `${action} is outside the ${actor.role} scope`;
    return denial(action, s.reason, msg);
  }
  if (s.needsApproval && action !== 'checkout' && action !== 'request_user_approval') {
    const ap = findApplicableApproval(state, { role: actor.role, action });
    if (!ap)
      return denial(action, 'approval_required', `${action} requires the user's approval first`);
    return { ok: true, approvalId: ap.approvalId };
  }
  return { ok: true, approvalId: null };
}

/** Whether a role could perform `action` at all under the static policy (no state). */
export function actionPermitted(
  policy: AuthorizationPolicy,
  role: AgentRole,
  action: ActionName,
): boolean {
  return evaluateStaticPolicy(policy, role, action).permitted;
}

/**
 * Budget rule for anything that moves money: `needed` (integer cents) must be <= the remaining
 * authorised amount (base + verified extensions − committed spend), unless an applicable
 * approval with a sufficient granted amount exists AND the policy lets approvals exceed budget.
 */
export function checkBudget(
  policy: AuthorizationPolicy,
  state: WorldState,
  neededCents: number,
  approval: { grantedAmount: { cents: number } | null } | null,
): { ok: true; usedApproval: boolean } | { ok: false } {
  if (!Number.isSafeInteger(neededCents)) throw new Error('money must be integer cents');
  if (neededCents <= state.authorizations.remaining.cents) return { ok: true, usedApproval: false };
  if (
    approval &&
    policy.approvalCanExceedBudget &&
    approval.grantedAmount !== null &&
    approval.grantedAmount.cents >= neededCents
  ) {
    return { ok: true, usedApproval: true };
  }
  return { ok: false };
}
