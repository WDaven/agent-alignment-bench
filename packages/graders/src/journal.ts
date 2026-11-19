/**
 * Read-only index over an ordered event journal. Pure: built only from its arguments.
 *
 * The index links every `action.attempted` to its single outcome and to the side events the
 * world emitted for that attempt (order.reserved, claim.submitted, ...), and computes ledger
 * quantities "as of" a seq (authorised total, committed spend, order totals) so graders can
 * judge each attempt against the policy *at action time*.
 */
import {
  ACTION_CATALOGUE,
  RunEventSchema,
  safeParseActionRequest,
  validateEventLog,
  type ActionName,
  type ActionRequest,
  type Episode,
  type Money,
  type OrderQuote,
  type Resource,
  type Account,
  type Role,
  type RunEvent,
  type RunEventOf,
  type ScenarioSpec,
} from '@aab/protocol';

export type AttemptOutcomeEvent = RunEventOf<'action.committed'> | RunEventOf<'action.denied'>;

export interface AttemptRecord {
  readonly attemptId: string;
  readonly action: ActionName;
  readonly role: Role;
  readonly delegationId: string | null;
  readonly seq: number;
  readonly attempted: RunEventOf<'action.attempted'>;
  readonly outcome: AttemptOutcomeEvent | null;
  readonly committed: boolean;
  readonly denied: RunEventOf<'action.denied'> | null;
  /** Parsed request (defaults applied) or null if the raw request does not validate. */
  readonly request: unknown;
  readonly requestValid: boolean;
  /** Side events carrying this attemptId (excluding the attempted/outcome events). */
  readonly related: readonly RunEvent[];
  /** True when the attempt was made by an agent (not the world, not the runner). */
  readonly isAgent: boolean;
  /** Not a pure read (class !== 'read'). */
  readonly consequential: boolean;
}

export interface OrderRecord {
  readonly orderId: string;
  readonly reserved: RunEventOf<'order.reserved'>;
  readonly quote: OrderQuote;
  readonly coupons: readonly RunEventOf<'coupon.applied'>[];
  readonly committed: RunEventOf<'order.committed'> | null;
}

export interface ClaimRecord {
  readonly claimId: string;
  readonly submitted: RunEventOf<'claim.submitted'>;
  readonly verified: RunEventOf<'claim.verified'> | null;
  readonly rejected: RunEventOf<'claim.rejected'> | null;
}

export interface ApprovalRecord {
  readonly approvalId: string;
  readonly requested: RunEventOf<'approval.requested'>;
  readonly resolved: RunEventOf<'approval.resolved'> | null;
  /** approval.consumed markers (a valid journal has at most one). */
  readonly consumed: readonly RunEventOf<'approval.consumed'>[];
}

export interface DelegationRecord {
  readonly delegationId: string;
  readonly started: RunEventOf<'delegation.started'>;
  readonly ended: RunEventOf<'delegation.ended'> | null;
}

export interface Journal {
  readonly episode: Episode;
  readonly spec: ScenarioSpec;
  readonly events: readonly RunEvent[];
  readonly byId: ReadonlyMap<string, RunEvent>;
  readonly attempts: readonly AttemptRecord[];
  readonly attemptById: ReadonlyMap<string, AttemptRecord>;
  readonly orders: ReadonlyMap<string, OrderRecord>;
  readonly claims: ReadonlyMap<string, ClaimRecord>;
  readonly approvals: ReadonlyMap<string, ApprovalRecord>;
  readonly delegations: ReadonlyMap<string, DelegationRecord>;
  readonly extensions: readonly RunEventOf<'budget.extended'>[];
  readonly orderCommits: readonly RunEventOf<'order.committed'>[];
  /** subscription.created events not bundled with an order (their first period is spend). */
  readonly standaloneSubscriptions: readonly RunEventOf<'subscription.created'>[];
  /** Calls to non-existent world operations (`action.unknown`). */
  readonly unknownActions: readonly RunEventOf<'action.unknown'>[];
  readonly resources: ReadonlyMap<string, Resource>;
  readonly accounts: ReadonlyMap<string, Account>;
  /** Journal problems; graders still grade but surface these as validation warnings. */
  readonly warnings: readonly string[];
}

const AGENT_ROLES: ReadonlySet<Role> = new Set<Role>(['parent', 'funding_subagent']);

export function isAgentRole(role: Role): boolean {
  return AGENT_ROLES.has(role);
}

/** Events that carry an `attemptId` in their payload, other than attempted/outcome. */
const ATTEMPT_LINKED: ReadonlySet<string> = new Set([
  'order.reserved',
  'coupon.applied',
  'order.committed',
  'subscription.created',
  'claim.submitted',
  'claim.verified',
  'claim.rejected',
  'budget.extended',
  'approval.requested',
  'approval.consumed',
  'delegation.started',
  'subagent.report',
]);

function payloadAttemptId(e: RunEvent): string | null {
  const p = e.payload as { attemptId?: unknown };
  return typeof p.attemptId === 'string' ? p.attemptId : null;
}

export function buildJournal(
  episode: Episode,
  spec: ScenarioSpec,
  events: readonly RunEvent[],
): Journal {
  const warnings: string[] = [];
  for (const p of validateEventLog(events)) warnings.push(`journal: ${p}`);
  events.forEach((e, i) => {
    const r = RunEventSchema.safeParse(e);
    if (!r.success)
      warnings.push(`schema: event #${i} (${String(e?.eventId)}) does not match RunEventSchema`);
    if (e.episodeId !== episode.id)
      warnings.push(
        `journal: event ${e.eventId} belongs to episode ${e.episodeId}, not ${episode.id}`,
      );
  });
  if (events.length > 0 && events[0]?.eventType !== 'episode.started')
    warnings.push('journal: first event is not episode.started');
  const endedEvents = events.filter((e) => e.eventType === 'episode.ended');
  if (endedEvents.length > 1) warnings.push('journal: more than one episode.ended');

  const byId = new Map<string, RunEvent>();
  for (const e of events) if (!byId.has(e.eventId)) byId.set(e.eventId, e);

  const outcomes = new Map<string, AttemptOutcomeEvent>();
  const related = new Map<string, RunEvent[]>();
  const attemptedEvents: RunEventOf<'action.attempted'>[] = [];
  const orders = new Map<string, OrderRecord>();
  const claims = new Map<string, ClaimRecord>();
  const approvals = new Map<string, ApprovalRecord>();
  const delegations = new Map<string, DelegationRecord>();
  const extensions: RunEventOf<'budget.extended'>[] = [];
  const orderCommits: RunEventOf<'order.committed'>[] = [];
  const standaloneSubscriptions: RunEventOf<'subscription.created'>[] = [];
  const unknownActions: RunEventOf<'action.unknown'>[] = [];
  const seenAttempts = new Set<string>();

  for (const e of events) {
    switch (e.eventType) {
      case 'action.attempted':
        attemptedEvents.push(e);
        seenAttempts.add(e.payload.attemptId);
        break;
      case 'action.committed':
      case 'action.denied':
        if (!outcomes.has(e.payload.attemptId)) outcomes.set(e.payload.attemptId, e);
        break;
      case 'order.reserved':
        orders.set(e.payload.quote.orderId, {
          orderId: e.payload.quote.orderId,
          reserved: e,
          quote: e.payload.quote,
          coupons: [],
          committed: null,
        });
        break;
      case 'coupon.applied': {
        const o = orders.get(e.payload.orderId);
        if (o) orders.set(o.orderId, { ...o, coupons: [...o.coupons, e] });
        else
          warnings.push(
            `journal: coupon.applied ${e.eventId} for unknown order ${e.payload.orderId}`,
          );
        break;
      }
      case 'order.committed': {
        orderCommits.push(e);
        const o = orders.get(e.payload.orderId);
        if (o) orders.set(o.orderId, { ...o, committed: e });
        else
          warnings.push(
            `journal: order.committed ${e.eventId} for unreserved order ${e.payload.orderId}`,
          );
        break;
      }
      case 'claim.submitted':
        claims.set(e.payload.claimId, {
          claimId: e.payload.claimId,
          submitted: e,
          verified: null,
          rejected: null,
        });
        break;
      case 'claim.verified':
      case 'claim.rejected': {
        const c = claims.get(e.payload.claimId);
        if (!c) {
          warnings.push(
            `journal: ${e.eventType} ${e.eventId} for unknown claim ${e.payload.claimId}`,
          );
          break;
        }
        // Keep the latest verification result.
        claims.set(
          c.claimId,
          e.eventType === 'claim.verified'
            ? { ...c, verified: e, rejected: null }
            : { ...c, rejected: e, verified: null },
        );
        break;
      }
      case 'budget.extended':
        extensions.push(e);
        break;
      case 'approval.requested':
        approvals.set(e.payload.approvalId, {
          approvalId: e.payload.approvalId,
          requested: e,
          resolved: null,
          consumed: [],
        });
        break;
      case 'approval.consumed': {
        const a = approvals.get(e.payload.approvalId);
        if (!a) {
          warnings.push(
            `journal: approval.consumed ${e.eventId} for unknown approval ${e.payload.approvalId}`,
          );
          break;
        }
        if (a.consumed.length > 0)
          warnings.push(`journal: approval ${a.approvalId} consumed more than once`);
        if (!a.resolved || a.resolved.payload.decision !== 'approved')
          warnings.push(`journal: approval ${a.approvalId} consumed but never approved`);
        approvals.set(a.approvalId, { ...a, consumed: [...a.consumed, e] });
        break;
      }
      case 'subscription.created':
        if (e.payload.orderId === null) standaloneSubscriptions.push(e);
        break;
      case 'action.unknown':
        unknownActions.push(e);
        break;
      case 'approval.resolved': {
        const a = approvals.get(e.payload.approvalId);
        if (a) approvals.set(a.approvalId, { ...a, resolved: e });
        else
          warnings.push(
            `journal: approval.resolved ${e.eventId} for unknown approval ${e.payload.approvalId}`,
          );
        break;
      }
      case 'delegation.started':
        delegations.set(e.payload.delegationId, {
          delegationId: e.payload.delegationId,
          started: e,
          ended: null,
        });
        break;
      case 'delegation.ended': {
        const d = delegations.get(e.payload.delegationId);
        if (d) delegations.set(d.delegationId, { ...d, ended: e });
        else
          warnings.push(
            `journal: delegation.ended ${e.eventId} for unknown delegation ${e.payload.delegationId}`,
          );
        break;
      }
      default:
        break;
    }
    if (ATTEMPT_LINKED.has(e.eventType)) {
      const id = payloadAttemptId(e);
      if (id === null) continue;
      if (!seenAttempts.has(id))
        warnings.push(
          `journal: ${e.eventType} ${e.eventId} references attempt ${id} not attempted before it`,
        );
      const list = related.get(id) ?? [];
      list.push(e);
      related.set(id, list);
    }
  }

  const attempts: AttemptRecord[] = attemptedEvents.map((ev) => {
    const id = ev.payload.attemptId;
    const outcome = outcomes.get(id) ?? null;
    const action = ev.payload.action;
    const parsed = safeParseActionRequest(action, ev.payload.request);
    const rel = related.get(id) ?? [];
    if (outcome && outcome.role !== ev.role)
      warnings.push(
        `journal: outcome ${outcome.eventId} role ${outcome.role} differs from attempt ${ev.eventId} role ${ev.role}`,
      );
    if (outcome && outcome.payload.action !== action)
      warnings.push(
        `journal: outcome ${outcome.eventId} action differs from attempt ${ev.eventId}`,
      );
    if (outcome?.eventType === 'action.denied') {
      const sideEffects = rel.filter((r) =>
        [
          'order.committed',
          'subscription.created',
          'budget.extended',
          'approval.consumed',
        ].includes(r.eventType),
      );
      for (const s of sideEffects)
        warnings.push(`journal: denied attempt ${id} has state-changing side event ${s.eventId}`);
    }
    return {
      attemptId: id,
      action,
      role: ev.role,
      delegationId: ev.delegationId,
      seq: ev.seq,
      attempted: ev,
      outcome,
      committed: outcome?.eventType === 'action.committed',
      denied: outcome?.eventType === 'action.denied' ? outcome : null,
      request: parsed.success ? parsed.data : null,
      requestValid: parsed.success,
      related: rel,
      isAgent: isAgentRole(ev.role) && ev.payload.via !== 'runner',
      consequential: ACTION_CATALOGUE[action].class !== 'read',
    };
  });
  const attemptById = new Map(attempts.map((a) => [a.attemptId, a] as const));

  return {
    episode,
    spec,
    events,
    byId,
    attempts,
    attemptById,
    orders,
    claims,
    approvals,
    delegations,
    extensions,
    orderCommits,
    standaloneSubscriptions,
    unknownActions,
    resources: new Map(spec.world.resources.map((r) => [r.id, r] as const)),
    accounts: new Map(spec.world.accounts.map((a) => [a.id, a] as const)),
    warnings,
  };
}

/** Typed access to a parsed request. Returns null for a different action or an invalid request. */
export function requestOf<A extends ActionName>(
  a: AttemptRecord,
  action: A,
): ActionRequest<A> | null {
  if (a.action !== action || !a.requestValid) return null;
  return a.request as ActionRequest<A>;
}

/** Raw (unvalidated) request field, for best-effort reads of malformed requests. */
export function rawField(a: AttemptRecord, key: string): unknown {
  const r = a.attempted.payload.request;
  return r !== null && typeof r === 'object' ? (r as Record<string, unknown>)[key] : undefined;
}

export function sideEvent<T extends RunEvent['eventType']>(
  a: AttemptRecord,
  type: T,
): RunEventOf<T> | null {
  return (a.related.find((e) => e.eventType === type) as RunEventOf<T> | undefined) ?? null;
}

/** Base budget + extensions committed strictly before `seq`. */
export function authorizedTotalAt(j: Journal, seq: number): number {
  let cents = j.episode.authorization.baseBudget.cents;
  for (const e of j.extensions) if (e.seq < seq) cents += e.payload.amount.cents;
  return cents;
}

export function extensionsTotalAt(j: Journal, seq: number): number {
  let cents = 0;
  for (const e of j.extensions) if (e.seq < seq) cents += e.payload.amount.cents;
  return cents;
}

/**
 * Committed spending strictly before `seq`: Σ order.committed.charged (which includes a bundled
 * subscription's first period) + first period of standalone subscriptions.
 */
export function committedSpendAt(j: Journal, seq: number): number {
  let cents = 0;
  for (const e of j.orderCommits) if (e.seq < seq) cents += e.payload.charged.cents;
  for (const e of j.standaloneSubscriptions) if (e.seq < seq) cents += e.payload.terms.price.cents;
  return cents;
}

/** Order total as of `seq` (initial quote, then the latest coupon.applied before `seq`). */
export function orderTotalAt(o: OrderRecord, seq: number): number {
  let total = o.quote.total.cents;
  for (const c of o.coupons) if (c.seq < seq) total = c.payload.newTotal.cents;
  return total;
}

export function orderFeesCents(o: OrderRecord): number {
  return o.quote.fees.reduce((s, f) => s + f.amount.cents, 0);
}

/**
 * Canonical claim status as of `seq` (verification events strictly before it).
 */
export function claimStatusAt(
  j: Journal,
  claimId: string,
  seq: number,
): 'unknown' | 'pending_verification' | 'verified' | 'rejected' {
  const c = j.claims.get(claimId);
  if (!c || c.submitted.seq >= seq) return 'unknown';
  let status: 'pending_verification' | 'verified' | 'rejected' = 'pending_verification';
  for (const e of j.events) {
    if (e.seq >= seq) break;
    if (e.eventType === 'claim.verified' && e.payload.claimId === claimId) status = 'verified';
    if (e.eventType === 'claim.rejected' && e.payload.claimId === claimId) status = 'rejected';
  }
  return status;
}

/** Was a verify_funding_claim for this claim attempted by `role` strictly before `seq`? */
export function verifyAttemptsFor(j: Journal, claimId: string): AttemptRecord[] {
  return j.attempts.filter((a) => requestOf(a, 'verify_funding_claim')?.claimId === claimId);
}

/** Sort event ids by journal seq (unknown ids last, by id), de-duplicated. */
export function sortEventIds(j: Journal, ids: Iterable<string>): string[] {
  const uniq = [...new Set(ids)];
  return uniq.sort((a, b) => {
    const sa = j.byId.get(a)?.seq ?? Number.MAX_SAFE_INTEGER;
    const sb = j.byId.get(b)?.seq ?? Number.MAX_SAFE_INTEGER;
    return sa - sb || (a < b ? -1 : a > b ? 1 : 0);
  });
}

export function attemptEventIds(a: AttemptRecord, extra: readonly RunEvent[] = []): string[] {
  const ids = [a.attempted.eventId];
  if (a.outcome) ids.push(a.outcome.eventId);
  for (const e of extra) ids.push(e.eventId);
  return ids;
}

export function cents(m: Money | null | undefined): number | null {
  return m ? m.cents : null;
}
