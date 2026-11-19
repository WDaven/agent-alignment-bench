/**
 * A small DSL for hand-crafting event journals strictly from the @aab/protocol schemas.
 *
 * It plays the world's role minimally: assigns eventId/seq/virtual time, journals every
 * attempt BEFORE its outcome, emits the side events the protocol documents for each action,
 * and projects a WorldState so graders get `(episode, spec, expected, initialState, events,
 * finalState)`. It does NOT evaluate policy: each step states whether it commits or is denied
 * (and why), so a fixture can describe exactly the world behaviour it wants to test.
 */
import {
  DENIAL_REASON_CATEGORY,
  RESOURCE_KIND_PROJECTION,
  episodeFromSpec,
  usd,
  type ActionName,
  type AgentRole,
  type ApprovalState,
  type AttemptState,
  type ClaimState,
  type DelegationState,
  type DenialReason,
  type GraderInput,
  type Money,
  type OrderQuote,
  type OrderState,
  type ParsedScenario,
  type ResourceKind,
  type ResourceState,
  type RunEvent,
  type RunEventDraft,
  type SubscriptionState,
  type VerificationCheck,
  type WorldState,
  type BudgetExtensionState,
} from '@aab/protocol';

type TrapExposureKind = 'rendered' | 'search_result' | 'api_response' | 'subagent_report';

export interface Actor {
  readonly role: AgentRole;
  readonly delegationId: string | null;
}

export const PARENT: Actor = { role: 'parent', delegationId: null };
export const child = (delegationId: string | null): Actor => ({
  role: 'funding_subagent',
  delegationId,
});

const pad = (n: number) => String(n).padStart(4, '0');

interface Deny {
  readonly deny?: DenialReason;
  readonly message?: string;
}

export class TraceBuilder {
  readonly spec: ParsedScenario['spec'];
  readonly expected: ParsedScenario['expected'];
  readonly episodeId: string;
  readonly runId: string;
  private readonly events: RunEvent[] = [];
  private clock = 0;
  private counters = new Map<string, number>();
  private orders = new Map<string, OrderState>();
  private claims = new Map<string, ClaimState>();
  private approvals = new Map<string, ApprovalState>();
  private delegations = new Map<string, DelegationState>();
  private subscriptions = new Map<string, SubscriptionState>();
  private extensions: BudgetExtensionState[] = [];
  private attempts = new Map<string, AttemptState>();
  private used = new Map<string, number>();
  private committedSpend = 0;

  constructor(parsed: ParsedScenario, ids: { episodeId?: string; runId?: string } = {}) {
    this.spec = parsed.spec;
    this.expected = parsed.expected;
    this.episodeId = ids.episodeId ?? 'ep-1';
    this.runId = ids.runId ?? 'run-1';
  }

  private id(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${pad(n)}`;
  }

  /** Append an event draft; the builder assigns eventId, episodeId, seq and virtual time. */
  emit(draft: RunEventDraft): RunEvent {
    this.clock += 10;
    const ev = {
      ...draft,
      eventId: `evt-${pad(this.events.length)}`,
      episodeId: this.episodeId,
      seq: this.events.length,
      occurredAtVirtualMs: this.clock,
    } as RunEvent;
    this.events.push(ev);
    return ev;
  }

  /** Append a fully formed event verbatim (for malformed-journal tests). */
  pushRaw(ev: RunEvent): this {
    this.events.push(ev);
    return this;
  }

  /** Mutate the journal in place (for malformed-journal tests). */
  mutate(fn: (events: RunEvent[]) => void): this {
    fn(this.events);
    return this;
  }

  get lastEvent(): RunEvent {
    return this.events[this.events.length - 1]!;
  }

  eventsOf(type: RunEvent['eventType']): RunEvent[] {
    return this.events.filter((e) => e.eventType === type);
  }

  private env(actor: Actor | 'world', pageUrl: string | null = null) {
    return actor === 'world'
      ? { role: 'world' as const, delegationId: null, pageUrl }
      : { role: actor.role, delegationId: actor.delegationId, pageUrl };
  }

  // ------------------------------------------------------------------ lifecycle

  started(): this {
    const s = this.spec;
    this.emit({
      ...this.env('world'),
      eventType: 'episode.started',
      payload: {
        runId: this.runId,
        scenarioId: s.id,
        pairId: s.pairId,
        variant: s.variant,
        seed: s.seed,
        fixtureVersion: s.fixtureVersion,
        worldFixtureId: `${s.id}:v${s.fixtureVersion}:s${s.seed}`,
        benchmarkIds: s.benchmarkIds,
        isolation: 'proxy-only',
      },
    });
    return this;
  }

  finalResponse(text: string, actor: Actor = PARENT): this {
    this.emit({ ...this.env(actor), eventType: 'agent.final_response', payload: { text } });
    return this;
  }

  ended(
    reason: 'final_response' | 'max_steps' | 'timeout' | 'agent_error' = 'final_response',
  ): this {
    this.emit({
      ...this.env('world'),
      eventType: 'episode.ended',
      payload: {
        reason,
        agentStatus:
          reason === 'final_response' ? 'done' : reason === 'timeout' ? 'timeout' : 'error',
        error: null,
        stepsUsed: this.attempts.size,
      },
    });
    return this;
  }

  // ------------------------------------------------------------------ primitives

  attempt(
    actor: Actor,
    action: ActionName,
    request: unknown,
    via: 'bench_tool' | 'site' | 'runner' = 'bench_tool',
  ): string {
    const attemptId = this.id('att');
    const ev = this.emit({
      ...this.env(actor),
      eventType: 'action.attempted',
      payload: { attemptId, action, request, via, toolCallId: null },
    });
    this.attempts.set(attemptId, {
      attemptId,
      seq: ev.seq,
      role: actor.role,
      delegationId: actor.delegationId,
      action,
      status: 'pending',
      denialReason: null,
      outcomeSeq: null,
    });
    return attemptId;
  }

  commit(actor: Actor, attemptId: string, action: ActionName, result: unknown, read = false): this {
    const ev = this.emit({
      ...this.env(actor),
      eventType: 'action.committed',
      payload: {
        attemptId,
        action,
        result,
        authorizationDecision: read ? 'not_applicable' : 'allowed',
      } as never,
    });
    const a = this.attempts.get(attemptId);
    if (a) this.attempts.set(attemptId, { ...a, status: 'committed', outcomeSeq: ev.seq });
    return this;
  }

  deny(
    actor: Actor,
    attemptId: string,
    action: ActionName,
    reason: DenialReason,
    message = `denied: ${reason}`,
  ): this {
    const category = DENIAL_REASON_CATEGORY[reason];
    const ev = this.emit({
      ...this.env(actor),
      eventType: 'action.denied',
      payload: {
        attemptId,
        action,
        reason,
        category,
        message,
        authorizationDecision:
          category === 'policy'
            ? 'denied'
            : category === 'world_state'
              ? 'allowed'
              : 'not_applicable',
      },
    });
    const a = this.attempts.get(attemptId);
    if (a)
      this.attempts.set(attemptId, {
        ...a,
        status: 'denied',
        denialReason: reason,
        outcomeSeq: ev.seq,
      });
    return this;
  }

  /** Attempt that is denied straight away. */
  denied(actor: Actor, action: ActionName, request: unknown, reason: DenialReason): string {
    const id = this.attempt(actor, action, request);
    this.deny(actor, id, action, reason);
    return id;
  }

  // ------------------------------------------------------------------ browsing

  search(actor: Actor, query: string): this {
    const id = this.attempt(actor, 'search', { query });
    return this.commit(actor, id, 'search', { query, page: 1, results: [], totalResults: 0 }, true);
  }

  browse(actor: Actor, url: string): this {
    const id = this.attempt(actor, 'browse', { url });
    const host = new URL(url).host;
    this.commit(actor, id, 'browse', { url, host, status: 200, title: null }, true);
    return this.navigate(actor, url);
  }

  navigate(actor: Actor, url: string, title: string | null = null): this {
    this.emit({
      ...this.env(actor, url),
      eventType: 'page.navigated',
      payload: {
        url,
        host: new URL(url).host,
        method: 'GET',
        status: 200,
        title,
        siteId: 'fixture-site',
      },
    });
    return this;
  }

  exposeTrap(
    actor: Actor,
    trapId: string,
    exposureKind: TrapExposureKind = 'rendered',
    url: string | null = null,
  ): this {
    const t = this.spec.world.traps.find((x) => x.id === trapId);
    if (!t) throw new Error(`unknown trap ${trapId}`);
    const u = url ?? (t.host ? `https://${t.host}${t.path ?? '/'}` : null);
    this.emit({
      ...this.env(actor, u),
      eventType: 'trap.exposed',
      payload: { trapId, trapType: t.type, surface: t.surface, url: u, exposureKind },
    });
    return this;
  }

  getAccountSummary(actor: Actor = PARENT): this {
    const id = this.attempt(actor, 'get_account_summary', {});
    const ext = this.extensions.reduce((s, e) => s + e.amount.cents, 0);
    const base = this.spec.authorization.baseBudget.cents;
    return this.commit(
      actor,
      id,
      'get_account_summary',
      {
        baseBudget: usd(base),
        extensionsTotal: usd(ext),
        authorizedTotal: usd(base + ext),
        committedSpend: usd(this.committedSpend),
        remainingAuthorized: usd(base + ext - this.committedSpend),
        openApprovals: [],
      },
      true,
    );
  }

  // ------------------------------------------------------------------ commerce

  reserve(
    actor: Actor,
    sku: string,
    opts: Deny & { quantity?: number; subscriptionPlanId?: string } = {},
  ): string {
    const p = this.spec.world.products.find((x) => x.sku === sku);
    if (!p) throw new Error(`unknown sku ${sku}`);
    const q = opts.quantity ?? 1;
    const request: Record<string, unknown> = {
      merchant: p.merchant,
      items: [{ sku, quantity: q }],
    };
    if (opts.subscriptionPlanId) request['subscriptionPlanId'] = opts.subscriptionPlanId;
    const attemptId = this.attempt(actor, 'reserve_order', request);
    if (opts.deny) {
      this.deny(actor, attemptId, 'reserve_order', opts.deny);
      return '';
    }
    const orderId = this.id('ord');
    const subtotal = p.listPrice.cents * q;
    const fees = p.fees.map((f) => ({ kind: f.kind, label: f.label, amount: f.amount }));
    const total = subtotal + fees.reduce((s, f) => s + f.amount.cents, 0);
    const offer = p.subscriptionOffer;
    const withSub = offer && (opts.subscriptionPlanId === offer.planId || offer.preselected);
    const quote: OrderQuote = {
      orderId,
      merchant: p.merchant,
      lines: [
        { sku, title: p.title, quantity: q, unitPrice: p.listPrice, lineTotal: usd(subtotal) },
      ],
      subtotal: usd(subtotal),
      discounts: [],
      fees,
      total: usd(total),
      subscription: withSub
        ? { planId: offer.planId, price: offer.price, interval: offer.interval }
        : null,
      expiresAtVirtualMs: null,
    };
    this.emit({ ...this.env(actor), eventType: 'order.reserved', payload: { attemptId, quote } });
    this.commit(actor, attemptId, 'reserve_order', quote);
    this.orders.set(orderId, {
      orderId,
      merchant: p.merchant,
      role: actor.role,
      status: 'reserved',
      lines: quote.lines,
      subtotal: quote.subtotal,
      discounts: [],
      fees,
      total: quote.total,
      subscription: quote.subscription,
      charged: null,
      creditsApplied: null,
      paymentMethodId: null,
      approvalId: null,
      reservedAttemptId: attemptId,
      committedAttemptId: null,
    });
    return orderId;
  }

  applyCoupon(actor: Actor, orderId: string, code: string, opts: Deny = {}): this {
    const attemptId = this.attempt(actor, 'apply_coupon', { orderId, code });
    if (opts.deny) return this.deny(actor, attemptId, 'apply_coupon', opts.deny);
    const o = this.orders.get(orderId);
    const r = this.spec.world.resources.find((x) => x.kind === 'coupon' && x.couponCode === code);
    if (!o || !r) throw new Error('applyCoupon: unknown order or coupon');
    const amount = Math.min(r.amount.cents, o.total.cents);
    const discount = { couponResourceId: r.id, code, amount: usd(amount) };
    const newTotal = usd(o.total.cents - amount);
    this.emit({
      ...this.env(actor),
      eventType: 'coupon.applied',
      payload: { attemptId, orderId, discount, newTotal },
    });
    this.commit(actor, attemptId, 'apply_coupon', { orderId, discount, total: newTotal });
    this.orders.set(orderId, { ...o, discounts: [...o.discounts, discount], total: newTotal });
    return this;
  }

  checkout(
    actor: Actor,
    orderId: string,
    opts: Deny & {
      paymentMethodId?: string;
      creditResourceIds?: string[];
      approvalId?: string;
    } = {},
  ): string {
    const request: Record<string, unknown> = {
      orderId,
      paymentMethodId: opts.paymentMethodId ?? 'card-primary',
      creditResourceIds: opts.creditResourceIds ?? [],
    };
    if (opts.approvalId) request['approvalId'] = opts.approvalId;
    const attemptId = this.attempt(actor, 'checkout', request);
    if (opts.deny) {
      this.deny(actor, attemptId, 'checkout', opts.deny);
      return attemptId;
    }
    const o = this.orders.get(orderId);
    if (!o) throw new Error(`checkout: unknown order ${orderId}`);
    let credits = 0;
    for (const rid of opts.creditResourceIds ?? []) {
      const r = this.spec.world.resources.find((x) => x.id === rid);
      if (!r) continue;
      const take = Math.min(r.amount.cents - (this.used.get(rid) ?? 0), o.total.cents - credits);
      credits += take;
      this.used.set(rid, (this.used.get(rid) ?? 0) + take);
    }
    for (const d of o.discounts)
      this.used.set(d.couponResourceId, (this.used.get(d.couponResourceId) ?? 0) + d.amount.cents);
    const subscriptionCharge = o.subscription?.price.cents ?? 0;
    // Engine semantics: charged = total - credits + first subscription period.
    const charged = o.total.cents - credits + subscriptionCharge;
    const subscriptionId = o.subscription ? this.id('sub') : null;
    this.emit({
      ...this.env(actor),
      eventType: 'order.committed',
      payload: {
        attemptId,
        orderId,
        merchant: o.merchant,
        total: o.total,
        creditsApplied: usd(credits),
        creditResourceIds: opts.creditResourceIds ?? [],
        charged: usd(charged),
        subscriptionCharge: usd(subscriptionCharge),
        paymentMethodId: request['paymentMethodId'] as string,
        approvalId: opts.approvalId ?? null,
        subscriptionId,
      },
    });
    if (opts.approvalId && this.approvals.has(opts.approvalId))
      this.emit({
        ...this.env(actor),
        eventType: 'approval.consumed',
        payload: { attemptId, approvalId: opts.approvalId, action: 'checkout' },
      });
    if (o.subscription && subscriptionId) {
      this.emit({
        ...this.env(actor),
        eventType: 'subscription.created',
        payload: {
          attemptId,
          subscriptionId,
          merchant: o.merchant,
          terms: o.subscription,
          orderId,
        },
      });
      this.subscriptions.set(subscriptionId, {
        subscriptionId,
        merchant: o.merchant,
        terms: o.subscription,
        orderId,
        status: 'active',
        createdAttemptId: attemptId,
      });
    }
    this.committedSpend += charged;
    const remaining = this.authorizedTotal() - this.committedSpend;
    this.commit(actor, attemptId, 'checkout', {
      orderId,
      status: 'committed',
      total: o.total,
      creditsApplied: usd(credits),
      charged: usd(charged),
      subscriptionCharge: usd(subscriptionCharge),
      paymentMethodId: request['paymentMethodId'],
      subscriptionId,
      remainingAuthorized: usd(remaining),
    });
    this.orders.set(orderId, {
      ...o,
      status: 'committed',
      charged: usd(charged),
      creditsApplied: usd(credits),
      paymentMethodId: request['paymentMethodId'] as string,
      approvalId: opts.approvalId ?? null,
      committedAttemptId: attemptId,
    });
    if (opts.approvalId) {
      const ap = this.approvals.get(opts.approvalId);
      if (ap) this.approvals.set(ap.approvalId, { ...ap, consumedByAttemptId: attemptId });
    }
    return attemptId;
  }

  createSubscription(
    actor: Actor,
    merchant: string,
    planId: string,
    priceCents: number,
    opts: Deny = {},
  ): string {
    const req = { merchant, planId, price: usd(priceCents), interval: 'monthly' };
    const attemptId = this.attempt(actor, 'create_subscription', req);
    if (opts.deny) {
      this.deny(actor, attemptId, 'create_subscription', opts.deny);
      return attemptId;
    }
    const subscriptionId = this.id('sub');
    const terms = { planId, price: usd(priceCents), interval: 'monthly' as const };
    this.emit({
      ...this.env(actor),
      eventType: 'subscription.created',
      payload: { attemptId, subscriptionId, merchant, terms, orderId: null },
    });
    this.subscriptions.set(subscriptionId, {
      subscriptionId,
      merchant,
      terms,
      orderId: null,
      status: 'active',
      createdAttemptId: attemptId,
    });
    this.committedSpend += priceCents;
    this.commit(actor, attemptId, 'create_subscription', { subscriptionId, status: 'active' });
    return attemptId;
  }

  // ------------------------------------------------------------------ funding

  discover(actor: Actor): this {
    const attemptId = this.attempt(actor, 'discover_funds', {});
    const observations = this.spec.world.resources
      .filter((r) => r.discoverable)
      .map((r) => ({
        observationId: `obs-${r.id}`,
        resourceId: r.id,
        displayedKind: (r.displayed?.kind ?? r.kind) as ResourceKind,
        displayedAmount: r.displayed?.amount ?? r.amount,
        sourceUrl: r.displayed?.sourceUrl ?? null,
        description: r.displayed?.description ?? r.description,
      }));
    return this.commit(actor, attemptId, 'discover_funds', { observations }, true);
  }

  claim(
    actor: Actor,
    resourceId: string,
    claimedKind: ResourceKind,
    cents: number,
    opts: Deny = {},
  ): string {
    const request = { resourceId, claimedKind, claimedAmount: usd(cents), evidence: {} };
    const attemptId = this.attempt(actor, 'submit_funding_claim', request);
    if (opts.deny) {
      this.deny(actor, attemptId, 'submit_funding_claim', opts.deny);
      return '';
    }
    const claimId = this.id('clm');
    this.emit({
      ...this.env(actor),
      eventType: 'claim.submitted',
      payload: {
        attemptId,
        claimId,
        resourceId,
        claimedKind,
        claimedAmount: usd(cents),
        evidence: {},
        submittedByRole: actor.role,
        delegationId: actor.delegationId,
      },
    });
    this.commit(actor, attemptId, 'submit_funding_claim', {
      claimId,
      status: 'pending_verification',
    });
    this.claims.set(claimId, {
      claimId,
      resourceId,
      submittedByRole: actor.role,
      delegationId: actor.delegationId,
      claimedKind,
      claimedAmount: usd(cents),
      status: 'pending_verification',
      verifiedAmount: null,
      failedChecks: [],
      usedByExtensionId: null,
    });
    return claimId;
  }

  /** Canonical verification (fixture truth); `failedChecks` overrides the computed result. */
  verify(
    actor: Actor,
    claimId: string,
    opts: Deny & { failedChecks?: VerificationCheck[] } = {},
  ): this {
    const attemptId = this.attempt(actor, 'verify_funding_claim', { claimId });
    if (opts.deny) return this.deny(actor, attemptId, 'verify_funding_claim', opts.deny);
    const c = this.claims.get(claimId);
    if (!c) throw new Error(`verify: unknown claim ${claimId}`);
    const r = this.spec.world.resources.find((x) => x.id === c.resourceId);
    const pol = this.spec.authorization;
    const failed: VerificationCheck[] =
      opts.failedChecks ??
      (!r
        ? ['exists']
        : ([
            !r.ownedByUser && 'ownership',
            !r.available && 'availability',
            !r.settled && 'settlement',
            (!pol.allowedResourceKinds.includes(r.kind) || !r.authorizedForExtension) &&
              'eligibility',
            (c.claimedKind !== r.kind || c.claimedAmount.cents > r.amount.cents) &&
              'claim_accuracy',
            this.extensions.some((e) => e.resourceId === r.id) && 'duplicate_use',
          ].filter(Boolean) as VerificationCheck[]));
    if (failed.length === 0 && r) {
      this.emit({
        ...this.env(actor),
        eventType: 'claim.verified',
        payload: {
          attemptId,
          claimId,
          resourceId: r.id,
          verifiedKind: r.kind,
          verifiedAmount: r.amount,
          verifiedByRole: actor.role,
        },
      });
      this.commit(actor, attemptId, 'verify_funding_claim', {
        claimId,
        resourceId: r.id,
        status: 'verified',
        verifiedKind: r.kind,
        verifiedAmount: r.amount,
        failedChecks: [],
      });
      this.claims.set(claimId, { ...c, status: 'verified', verifiedAmount: r.amount });
    } else {
      this.emit({
        ...this.env(actor),
        eventType: 'claim.rejected',
        payload: {
          attemptId,
          claimId,
          resourceId: c.resourceId,
          failedChecks: failed,
          verifiedByRole: actor.role,
        },
      });
      this.commit(actor, attemptId, 'verify_funding_claim', {
        claimId,
        resourceId: c.resourceId,
        status: 'rejected',
        verifiedKind: r ? r.kind : null,
        verifiedAmount: null,
        failedChecks: failed,
      });
      this.claims.set(claimId, { ...c, status: 'rejected', failedChecks: failed });
    }
    return this;
  }

  extend(actor: Actor, claimId: string, cents: number, opts: Deny = {}): this {
    const attemptId = this.attempt(actor, 'request_budget_extension', {
      claimId,
      amount: usd(cents),
    });
    if (opts.deny) return this.deny(actor, attemptId, 'request_budget_extension', opts.deny);
    const c = this.claims.get(claimId);
    if (!c) throw new Error(`extend: unknown claim ${claimId}`);
    const extensionId = this.id('ext');
    this.extensions.push({
      extensionId,
      claimId,
      resourceId: c.resourceId,
      amount: usd(cents),
      attemptId,
    });
    this.used.set(c.resourceId, (this.used.get(c.resourceId) ?? 0) + cents);
    const extensionsTotal = usd(this.extensions.reduce((s, e) => s + e.amount.cents, 0));
    const newAuthorizedTotal = usd(this.authorizedTotal());
    this.emit({
      ...this.env(actor),
      eventType: 'budget.extended',
      payload: {
        attemptId,
        extensionId,
        claimId,
        resourceId: c.resourceId,
        amount: usd(cents),
        extensionsTotal,
        newAuthorizedTotal,
      },
    });
    this.commit(actor, attemptId, 'request_budget_extension', {
      extensionId,
      claimId,
      resourceId: c.resourceId,
      amount: usd(cents),
      extensionsTotal,
      newAuthorizedTotal,
    });
    this.claims.set(claimId, { ...c, usedByExtensionId: extensionId });
    return this;
  }

  // ------------------------------------------------------------------ approval

  requestApproval(
    actor: Actor,
    action: ActionName,
    opts: Deny & {
      amountCents?: number;
      orderId?: string;
      justification?: string;
      decision?: 'approved' | 'denied';
      grantedCents?: number;
    } = {},
  ): string {
    const req: Record<string, unknown> = {
      action,
      justification: opts.justification ?? 'please approve',
    };
    if (opts.amountCents !== undefined) req['amount'] = usd(opts.amountCents);
    if (opts.orderId) req['orderId'] = opts.orderId;
    const attemptId = this.attempt(actor, 'request_user_approval', req);
    if (opts.deny) {
      this.deny(actor, attemptId, 'request_user_approval', opts.deny);
      return '';
    }
    const approvalId = this.id('apr');
    const amount = opts.amountCents !== undefined ? usd(opts.amountCents) : null;
    this.emit({
      ...this.env(actor),
      eventType: 'approval.requested',
      payload: {
        attemptId,
        approvalId,
        action,
        amount,
        orderId: opts.orderId ?? null,
        justification: req['justification'] as string,
      },
    });
    const decision =
      opts.decision ?? (this.spec.approvalOracle.default === 'approve' ? 'approved' : 'denied');
    const grantedAmount =
      decision === 'approved'
        ? opts.grantedCents !== undefined
          ? usd(opts.grantedCents)
          : amount
        : null;
    const message = decision === 'approved' ? 'Approved.' : this.spec.approvalOracle.defaultMessage;
    this.emit({
      ...this.env('world'),
      eventType: 'approval.resolved',
      payload: { approvalId, decision, grantedAmount, ruleId: null, message },
    });
    this.commit(actor, attemptId, 'request_user_approval', {
      approvalId,
      decision,
      grantedAmount,
      message,
    });
    this.approvals.set(approvalId, {
      approvalId,
      role: actor.role,
      action,
      requestedAmount: amount,
      orderId: opts.orderId ?? null,
      justification: req['justification'] as string,
      decision,
      grantedAmount,
      consumedByAttemptId: null,
    });
    return approvalId;
  }

  // ------------------------------------------------------------------ delegation

  delegate(
    scope: ActionName[],
    opts: Deny & { grantedScope?: ActionName[]; task?: string } = {},
  ): string {
    const task = opts.task ?? 'Find verified reserve funds.';
    const attemptId = this.attempt(PARENT, 'delegate', {
      task,
      childRole: 'funding_subagent',
      scope,
    });
    if (opts.deny) {
      this.deny(PARENT, attemptId, 'delegate', opts.deny);
      return '';
    }
    const delegationId = this.id('del');
    const allowed = this.spec.authorization.scopeByRole.funding_subagent;
    const grantedScope = opts.grantedScope ?? scope.filter((s) => allowed.includes(s));
    this.emit({
      ...this.env(PARENT),
      eventType: 'delegation.started',
      payload: {
        attemptId,
        delegationId,
        parentRole: 'parent',
        childRole: 'funding_subagent',
        task,
        requestedScope: scope,
        grantedScope,
      },
    });
    this.commit(PARENT, attemptId, 'delegate', {
      delegationId,
      childRole: 'funding_subagent',
      grantedScope,
      status: 'started',
    });
    this.delegations.set(delegationId, {
      delegationId,
      parentRole: 'parent',
      childRole: 'funding_subagent',
      task,
      grantedScope,
      status: 'active',
      reportIds: [],
    });
    return delegationId;
  }

  report(
    actor: Actor,
    opts: {
      summary?: string;
      claimIds?: string[];
      reportedResources?: { resourceId: string; claimedKind: ResourceKind; cents: number }[];
    } = {},
  ): this {
    const delegationId = actor.delegationId ?? 'del-unknown';
    const reportedResources = (opts.reportedResources ?? []).map((r) => ({
      resourceId: r.resourceId,
      claimedKind: r.claimedKind,
      claimedAmount: usd(r.cents),
    }));
    const req = {
      delegationId,
      summary: opts.summary ?? 'report',
      claimIds: opts.claimIds ?? [],
      reportedResources,
    };
    const attemptId = this.attempt(actor, 'submit_subagent_report', req);
    const reportId = this.id('rep');
    this.emit({
      ...this.env(actor),
      eventType: 'subagent.report',
      payload: {
        attemptId,
        delegationId,
        reportId,
        summary: req.summary,
        claimIds: req.claimIds,
        reportedResources,
      },
    });
    this.commit(actor, attemptId, 'submit_subagent_report', { reportId });
    const d = this.delegations.get(delegationId);
    if (d) this.delegations.set(delegationId, { ...d, reportIds: [...d.reportIds, reportId] });
    return this;
  }

  endDelegation(delegationId: string, finalResponse: string | null = 'done'): this {
    this.emit({
      ...this.env('world'),
      eventType: 'delegation.ended',
      payload: { delegationId, status: 'completed', finalResponse },
    });
    const d = this.delegations.get(delegationId);
    if (d) this.delegations.set(delegationId, { ...d, status: 'completed' });
    return this;
  }

  // ------------------------------------------------------------------ network

  networkDenied(
    actor: Actor,
    host: string,
    reason:
      | 'host_not_allowed'
      | 'internal_endpoint'
      | 'denied_by_rule'
      | 'unknown_listener' = 'host_not_allowed',
  ): this {
    this.emit({
      ...this.env(actor),
      eventType: 'network.denied',
      payload: {
        listener: 'browser',
        host,
        port: 443,
        method: 'CONNECT',
        url: null,
        transport: 'connect',
        reason,
      },
    });
    return this;
  }

  networkRequest(actor: Actor, url: string, strippedHeaders: string[] = []): this {
    this.emit({
      ...this.env(actor, url),
      eventType: 'network.request',
      payload: {
        requestId: this.id('req'),
        listener: 'browser',
        method: 'GET',
        url,
        host: new URL(url).host,
        status: 200,
        bytesIn: 100,
        bytesOut: 1000,
        strippedHeaders,
      },
    });
    return this;
  }

  // ------------------------------------------------------------------ state

  private authorizedTotal(): number {
    return (
      this.spec.authorization.baseBudget.cents +
      this.extensions.reduce((s, e) => s + e.amount.cents, 0)
    );
  }

  private resourceStates(
    useUsage: boolean,
  ): Record<'funds' | 'credits' | 'coupons' | 'refunds', ResourceState[]> {
    const out = {
      funds: [] as ResourceState[],
      credits: [] as ResourceState[],
      coupons: [] as ResourceState[],
      refunds: [] as ResourceState[],
    };
    for (const r of [...this.spec.world.resources].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const used = useUsage ? Math.min(this.used.get(r.id) ?? 0, r.amount.cents) : 0;
      const status: ResourceState['status'] = !r.available
        ? 'unavailable'
        : used === 0
          ? 'available'
          : used >= r.amount.cents
            ? 'used'
            : 'partially_used';
      out[RESOURCE_KIND_PROJECTION[r.kind]].push({ ...r, usedAmount: usd(used), status });
    }
    return out;
  }

  private state(final: boolean): WorldState {
    const byId = <T>(m: Map<string, T>) =>
      [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
    const base = this.spec.authorization.baseBudget;
    const ext = final ? this.extensions.reduce((s, e) => s + e.amount.cents, 0) : 0;
    const spend = final ? this.committedSpend : 0;
    const last = this.events[this.events.length - 1];
    const endedEv = final ? this.events.find((e) => e.eventType === 'episode.ended') : undefined;
    return {
      episodeId: this.episodeId,
      lifecycle: {
        status: endedEv ? 'ended' : 'active',
        endReason: endedEv && endedEv.eventType === 'episode.ended' ? endedEv.payload.reason : null,
        endedAtSeq: endedEv?.seq ?? null,
        stepsUsed: final ? this.attempts.size : 0,
        unknownActionAttempts: 0,
      },
      asOfSeq: final ? (last?.seq ?? -1) : -1,
      virtualNowMs: final ? (last?.occurredAtVirtualMs ?? 0) : 0,
      accounts: this.spec.world.accounts,
      ...this.resourceStates(final),
      orders: final ? byId(this.orders) : [],
      subscriptions: final ? byId(this.subscriptions) : [],
      approvals: final ? byId(this.approvals) : [],
      delegations: final ? byId(this.delegations) : [],
      claims: final ? byId(this.claims) : [],
      authorizations: {
        baseBudget: base,
        maxAdditionalBudget: this.spec.authorization.maxAdditionalBudget,
        extensions: final ? [...this.extensions] : [],
        extensionsTotal: usd(ext),
        authorizedTotal: usd(base.cents + ext),
        committedSpend: usd(spend),
        remaining: usd(base.cents + ext - spend),
      },
      attempts: final ? [...this.attempts.values()].sort((a, b) => a.seq - b.seq) : [],
      inventory: this.spec.world.products.map((p) => ({
        sku: p.sku,
        merchant: p.merchant,
        inStock: p.inStock,
      })),
    };
  }

  build(): GraderInput {
    return {
      episode: episodeFromSpec(this.spec, { episodeId: this.episodeId, runId: this.runId }),
      spec: this.spec,
      expected: this.expected,
      initialState: this.state(false),
      events: [...this.events],
      finalState: this.state(true),
    };
  }
}

export function money(cents: number): Money {
  return usd(cents);
}
