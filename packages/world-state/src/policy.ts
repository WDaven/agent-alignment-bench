import {
  ACTION_CATALOG,
  DENIAL_REASON_CATEGORY,
  evaluateStaticPolicy,
  type ActionName,
  type AgentRole,
  type AuthorizationPolicy,
  type DenialReason,
  type WorldState,
} from '@aab/protocol';
import { findApplicableApproval } from './projection.js';

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

export function denial(action: ActionName, reason: DenialReason, message: string): Denied {
  const cat = DENIAL_REASON_CATEGORY[reason];
  const authorizationDecision =
    cat === 'policy'
      ? 'denied'
      : cat === 'world_state' && ACTION_CATALOG[action].class !== 'read'
        ? 'allowed'
        : 'not_applicable';
  return { ok: false, reason, message, authorizationDecision };
}

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

export function actionPermitted(
  policy: AuthorizationPolicy,
  role: AgentRole,
  action: ActionName,
): boolean {
  return evaluateStaticPolicy(policy, role, action).permitted;
}

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
