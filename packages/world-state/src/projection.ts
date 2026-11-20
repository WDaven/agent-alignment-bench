import {
  RESOURCE_KIND_PROJECTION,
  type AgentRole,
  type ApprovalState,
  type EventPayload,
  type ResourceState,
  type RunEvent,
  type ScenarioSpec,
  type WorldState,
} from '@aab/protocol';
import { jsonClone, minC, money } from './util.js';

export interface AuxState {
  episodeEnded: boolean;
  pendingApprovals: Record<
    string,
    { role: AgentRole; payload: EventPayload<'approval.requested'> }
  >;
  trapExposures: string[];
  orderExpiry: Record<string, number | null>;
}

export interface Projection {
  world: WorldState;
  aux: AuxState;
}

export function resourceStatus(
  r: Pick<ResourceState, 'available' | 'amount' | 'usedAmount'>,
): ResourceState['status'] {
  if (!r.available) return 'unavailable';
  if (r.usedAmount.cents <= 0) return 'available';
  return r.usedAmount.cents >= r.amount.cents ? 'used' : 'partially_used';
}

export function initialProjection(spec: ScenarioSpec, episodeId: string): Projection {
  const w = spec.world;
  const lists: Record<'funds' | 'credits' | 'coupons' | 'refunds', ResourceState[]> = {
    funds: [],
    credits: [],
    coupons: [],
    refunds: [],
  };
  for (const r of [...w.resources].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const rs: ResourceState = { ...jsonClone(r), usedAmount: money(0), status: 'available' };
    rs.status = resourceStatus(rs);
    lists[RESOURCE_KIND_PROJECTION[r.kind]].push(rs);
  }
  const a = spec.authorization;
  const world: WorldState = {
    episodeId,
    lifecycle: {
      status: 'active',
      endReason: null,
      endedAtSeq: null,
      stepsUsed: 0,
      unknownActionAttempts: 0,
    },
    asOfSeq: -1,
    virtualNowMs: 0,
    accounts: jsonClone([...w.accounts].sort((x, y) => (x.id < y.id ? -1 : 1))),
    ...lists,
    orders: [],
    subscriptions: [],
    approvals: [],
    delegations: [],
    claims: [],
    authorizations: {
      baseBudget: money(a.baseBudget.cents),
      maxAdditionalBudget: money(a.maxAdditionalBudget.cents),
      extensions: [],
      extensionsTotal: money(0),
      authorizedTotal: money(a.baseBudget.cents),
      committedSpend: money(0),
      remaining: money(a.baseBudget.cents),
    },
    attempts: [],
    inventory: [...w.products]
      .sort((x, y) => (x.sku < y.sku ? -1 : 1))
      .map((p) => ({ sku: p.sku, merchant: p.merchant, inStock: p.inStock })),
  };
  return {
    world,
    aux: { episodeEnded: false, pendingApprovals: {}, trapExposures: [], orderExpiry: {} },
  };
}

export function allResources(w: WorldState): ResourceState[] {
  return [...w.funds, ...w.credits, ...w.coupons, ...w.refunds];
}

export function findResource(w: WorldState, id: string): ResourceState | undefined {
  return allResources(w).find((r) => r.id === id);
}

export function remainingOf(r: ResourceState): number {
  return Math.max(0, r.amount.cents - r.usedAmount.cents);
}

export function allocateCredits(
  w: WorldState,
  resourceIds: readonly string[],
  totalCents: number,
): { allocations: { resourceId: string; cents: number }[]; appliedCents: number } {
  let left = totalCents;
  const allocations: { resourceId: string; cents: number }[] = [];
  for (const id of resourceIds) {
    const r = findResource(w, id);
    const take = r ? minC(remainingOf(r), left) : 0;
    allocations.push({ resourceId: id, cents: take });
    left -= take;
  }
  return { allocations, appliedCents: totalCents - left };
}

export function findApplicableApproval(
  w: WorldState,
  q: {
    role: AgentRole;
    action: string;
    approvalId?: string | null;
    orderId?: string | null;
    amountCents?: number | null;
  },
): ApprovalState | undefined {
  const candidates = q.approvalId
    ? w.approvals.filter((a) => a.approvalId === q.approvalId)
    : w.approvals;
  return candidates.find(
    (a) =>
      a.decision === 'approved' &&
      a.consumedByAttemptId === null &&
      a.role === q.role &&
      a.action === q.action &&
      (a.orderId === null || q.orderId == null || a.orderId === q.orderId) &&
      (q.amountCents == null || a.grantedAmount === null || a.grantedAmount.cents >= q.amountCents),
  );
}

function updateResource(w: WorldState, id: string, addUsedCents: number): void {
  const r = findResource(w, id);
  if (!r) return;
  r.usedAmount = money(r.usedAmount.cents + addUsedCents);
  r.status = resourceStatus(r);
}

function recomputeAuthorization(w: WorldState): void {
  const a = w.authorizations;
  a.extensionsTotal = money(a.extensions.reduce((s, e) => s + e.amount.cents, 0));
  a.authorizedTotal = money(a.baseBudget.cents + a.extensionsTotal.cents);
  a.remaining = money(a.authorizedTotal.cents - a.committedSpend.cents);
}

function asAgentRole(role: RunEvent['role']): AgentRole {
  if (role === 'world') throw new Error('agent-role event emitted with role world');
  return role;
}

export function applyEvent(prev: Projection, e: RunEvent): Projection {
  const next = jsonClone(prev);
  const w = next.world;
  w.asOfSeq = e.seq;
  w.virtualNowMs = e.occurredAtVirtualMs;

  switch (e.eventType) {
    case 'episode.ended':
      next.aux.episodeEnded = true;
      w.lifecycle.status = 'ended';
      w.lifecycle.endReason = e.payload.reason;
      w.lifecycle.endedAtSeq = e.seq;
      break;
    case 'action.unknown':
      w.lifecycle.unknownActionAttempts += 1;
      break;
    case 'approval.consumed': {
      const ap = w.approvals.find((a) => a.approvalId === e.payload.approvalId);
      if (ap) ap.consumedByAttemptId = e.payload.attemptId;
      break;
    }
    case 'action.attempted':
      w.lifecycle.stepsUsed += 1;
      w.attempts.push({
        attemptId: e.payload.attemptId,
        seq: e.seq,
        role: e.role,
        delegationId: e.delegationId,
        action: e.payload.action,
        status: 'pending',
        denialReason: null,
        outcomeSeq: null,
      });
      break;
    case 'action.committed': {
      const at = w.attempts.find((a) => a.attemptId === e.payload.attemptId);
      if (at) {
        at.status = 'committed';
        at.outcomeSeq = e.seq;
      }
      break;
    }
    case 'action.denied': {
      const at = w.attempts.find((a) => a.attemptId === e.payload.attemptId);
      if (at) {
        at.status = 'denied';
        at.denialReason = e.payload.reason;
        at.outcomeSeq = e.seq;
      }
      break;
    }
    case 'order.reserved': {
      const q = e.payload.quote;
      w.orders.push({
        orderId: q.orderId,
        merchant: q.merchant,
        role: asAgentRole(e.role),
        status: 'reserved',
        lines: q.lines,
        subtotal: q.subtotal,
        discounts: q.discounts,
        fees: q.fees,
        total: q.total,
        subscription: q.subscription,
        charged: null,
        creditsApplied: null,
        paymentMethodId: null,
        approvalId: null,
        reservedAttemptId: e.payload.attemptId,
        committedAttemptId: null,
      });
      w.orders.sort((a, b) => (a.orderId < b.orderId ? -1 : 1));
      next.aux.orderExpiry[q.orderId] = q.expiresAtVirtualMs;
      break;
    }
    case 'coupon.applied': {
      const o = w.orders.find((x) => x.orderId === e.payload.orderId);
      if (o) {
        o.discounts.push(e.payload.discount);
        o.total = e.payload.newTotal;
      }
      break;
    }
    case 'order.committed': {
      const p = e.payload;
      const o = w.orders.find((x) => x.orderId === p.orderId);
      if (o) {
        const alloc = allocateCredits(w, p.creditResourceIds, o.total.cents);
        for (const a of alloc.allocations) updateResource(w, a.resourceId, a.cents);
        for (const d of o.discounts) updateResource(w, d.couponResourceId, d.amount.cents);
        o.status = 'committed';
        o.charged = p.charged;
        o.creditsApplied = p.creditsApplied;
        o.paymentMethodId = p.paymentMethodId;
        o.approvalId = p.approvalId;
        o.committedAttemptId = p.attemptId;
      }
      w.authorizations.committedSpend = money(
        w.authorizations.committedSpend.cents + p.charged.cents,
      );
      break;
    }
    case 'subscription.created': {
      const p = e.payload;
      w.subscriptions.push({
        subscriptionId: p.subscriptionId,
        merchant: p.merchant,
        terms: p.terms,
        orderId: p.orderId,
        status: 'active',
        createdAttemptId: p.attemptId,
      });
      w.subscriptions.sort((a, b) => (a.subscriptionId < b.subscriptionId ? -1 : 1));
      if (p.orderId === null)
        w.authorizations.committedSpend = money(
          w.authorizations.committedSpend.cents + p.terms.price.cents,
        );
      break;
    }
    case 'claim.submitted': {
      const p = e.payload;
      w.claims.push({
        claimId: p.claimId,
        resourceId: p.resourceId,
        submittedByRole: p.submittedByRole,
        delegationId: p.delegationId,
        claimedKind: p.claimedKind,
        claimedAmount: p.claimedAmount,
        status: 'pending_verification',
        verifiedAmount: null,
        failedChecks: [],
        usedByExtensionId: null,
      });
      w.claims.sort((a, b) => (a.claimId < b.claimId ? -1 : 1));
      break;
    }
    case 'claim.verified': {
      const c = w.claims.find((x) => x.claimId === e.payload.claimId);
      if (c) {
        c.status = 'verified';
        c.verifiedAmount = e.payload.verifiedAmount;
        c.failedChecks = [];
      }
      break;
    }
    case 'claim.rejected': {
      const c = w.claims.find((x) => x.claimId === e.payload.claimId);
      if (c) {
        c.status = 'rejected';
        c.verifiedAmount = null;
        c.failedChecks = e.payload.failedChecks;
      }
      break;
    }
    case 'budget.extended': {
      const p = e.payload;
      w.authorizations.extensions.push({
        extensionId: p.extensionId,
        claimId: p.claimId,
        resourceId: p.resourceId,
        amount: p.amount,
        attemptId: p.attemptId,
      });
      const c = w.claims.find((x) => x.claimId === p.claimId);
      if (c) c.usedByExtensionId = p.extensionId;
      updateResource(w, p.resourceId, p.amount.cents);
      break;
    }
    case 'approval.requested':
      next.aux.pendingApprovals[e.payload.approvalId] = {
        role: asAgentRole(e.role),
        payload: e.payload,
      };
      break;
    case 'approval.resolved': {
      const pending = next.aux.pendingApprovals[e.payload.approvalId];
      if (pending) {
        delete next.aux.pendingApprovals[e.payload.approvalId];
        w.approvals.push({
          approvalId: e.payload.approvalId,
          role: pending.role,
          action: pending.payload.action,
          requestedAmount: pending.payload.amount,
          orderId: pending.payload.orderId,
          justification: pending.payload.justification,
          decision: e.payload.decision,
          grantedAmount: e.payload.grantedAmount,
          consumedByAttemptId: null,
        });
        w.approvals.sort((a, b) => (a.approvalId < b.approvalId ? -1 : 1));
      }
      break;
    }
    case 'delegation.started': {
      const p = e.payload;
      w.delegations.push({
        delegationId: p.delegationId,
        parentRole: p.parentRole,
        childRole: p.childRole,
        task: p.task,
        grantedScope: p.grantedScope,
        status: 'active',
        reportIds: [],
      });
      w.delegations.sort((a, b) => (a.delegationId < b.delegationId ? -1 : 1));
      break;
    }
    case 'delegation.ended': {
      const d = w.delegations.find((x) => x.delegationId === e.payload.delegationId);
      if (d) d.status = e.payload.status;
      break;
    }
    case 'subagent.report': {
      const d = w.delegations.find((x) => x.delegationId === e.payload.delegationId);
      if (d) d.reportIds.push(e.payload.reportId);
      break;
    }
    case 'trap.exposed':
      next.aux.trapExposures.push(`${e.payload.trapId}\u0000${e.payload.url ?? ''}`);
      break;
    default:
      break;
  }

  for (const o of w.orders) {
    const exp = next.aux.orderExpiry[o.orderId];
    if (o.status === 'reserved' && exp != null && w.virtualNowMs > exp) o.status = 'expired';
  }
  recomputeAuthorization(w);
  return next;
}

export function replay(
  spec: ScenarioSpec,
  episodeId: string,
  events: readonly RunEvent[],
): Projection {
  let p = initialProjection(spec, episodeId);
  for (const e of events) p = applyEvent(p, e);
  return p;
}
