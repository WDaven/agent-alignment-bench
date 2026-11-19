import { z } from 'zod';
import {
  ACTION_CATALOGUE,
  ACTION_NAMES,
  ActionNameSchema,
  ClaimEvidenceSchema,
  DiscountSchema,
  OrderQuoteSchema,
  ReportedResourceSchema,
  SubscriptionTermsSchema,
  type ActionName,
  type ActionResult,
} from './actions.js';
import { McpServerNameSchema, AgentRunStatusSchema } from './agent.js';
import {
  AgentRoleSchema,
  ApprovalIdSchema,
  AttemptIdSchema,
  BenchmarkIdSchema,
  ClaimIdSchema,
  DelegationIdSchema,
  EpisodeIdSchema,
  EventIdSchema,
  HostSchema,
  IdSchema,
  JsonValueSchema,
  OrderIdSchema,
  ResourceIdSchema,
  RoleSchema,
  RunIdSchema,
  ScenarioIdSchema,
  TrapIdSchema,
  VariantSchema,
  VirtualMsSchema,
} from './common.js';
import { DenialCategorySchema, DenialReasonSchema } from './denials.js';
import { NonNegativeMoneySchema } from './money.js';
import { ResourceKindSchema, VerificationCheckSchema } from './resources.js';
import { IsolationSchema } from './run.js';
import { TrapSurfaceSchema, TrapTypeSchema } from './scenario.js';

/**
 * Closed catalogue of journal event types. All events share an envelope; `seq` is assigned
 * by the world service (strictly increasing, gap-free from 0 per episode) and is the only
 * ordering. Payload schemas are below and summarised in docs/protocol.md.
 */
export const EventTypeSchema = z.enum([
  'episode.started',
  'episode.ended',
  'action.attempted',
  'action.committed',
  'action.denied',
  'action.unknown',
  'order.reserved',
  'coupon.applied',
  'order.committed',
  'subscription.created',
  'claim.submitted',
  'claim.verified',
  'claim.rejected',
  'budget.extended',
  'approval.requested',
  'approval.resolved',
  'approval.consumed',
  'delegation.started',
  'delegation.ended',
  'subagent.report',
  'page.navigated',
  'trap.exposed',
  'network.request',
  'network.tunnel',
  'network.denied',
  'tool.call',
  'agent.final_response',
]);
export type EventType = z.infer<typeof EventTypeSchema>;
export const EVENT_TYPES = EventTypeSchema.options;

/** Where an attempted action came from. */
export const ActionViaSchema = z.enum([
  /** The agent called a `bench` MCP tool. */
  'bench_tool',
  /** A site plugin called the world op on behalf of a browser interaction (e.g. a checkout form POST). */
  'site',
  /** The runner (e.g. starting/ending delegations). */
  'runner',
]);
export type ActionVia = z.infer<typeof ActionViaSchema>;

/**
 * `allowed`: policy permitted it. `denied`: policy refused it. `not_applicable`: no policy question
 * (e.g. reads, or validation failures before policy evaluation).
 */
export const AuthorizationDecisionSchema = z.enum(['allowed', 'denied', 'not_applicable']);
export type AuthorizationDecision = z.infer<typeof AuthorizationDecisionSchema>;

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export const EpisodeStartedPayloadSchema = z.strictObject({
  runId: RunIdSchema,
  scenarioId: ScenarioIdSchema,
  pairId: IdSchema,
  variant: VariantSchema,
  seed: z.number().int().nonnegative(),
  fixtureVersion: z.string(),
  worldFixtureId: IdSchema,
  benchmarkIds: z.array(BenchmarkIdSchema),
  isolation: IsolationSchema,
});

export const EpisodeEndReasonSchema = z.enum([
  'final_response',
  'max_steps',
  'timeout',
  'agent_error',
  'harness_error',
  'aborted',
]);
export const EpisodeEndedPayloadSchema = z.strictObject({
  reason: EpisodeEndReasonSchema,
  agentStatus: AgentRunStatusSchema.nullable(),
  error: z.string().nullable(),
  /** World actions attempted by all roles. */
  stepsUsed: z.number().int().nonnegative(),
});

/**
 * Journaled BEFORE validation and policy evaluation, so `request` is the raw, possibly
 * malformed request (validate with parseActionRequest). Exactly one action.committed or
 * action.denied with the same attemptId follows.
 */
export const ActionAttemptedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  action: ActionNameSchema,
  request: z.unknown(),
  via: ActionViaSchema,
  /** The tool.call that triggered it, if any. */
  toolCallId: IdSchema.nullable(),
});

/** Executed. `result` is typed by `action` (see ActionCommittedPayload). */
export type ActionCommittedPayload = {
  [A in ActionName]: {
    attemptId: string;
    action: A;
    result: ActionResult<A>;
    authorizationDecision: 'allowed' | 'not_applicable';
  };
}[ActionName];

export const ActionCommittedPayloadSchema = z.discriminatedUnion(
  'action',
  ACTION_NAMES.map((a) =>
    z.strictObject({
      attemptId: AttemptIdSchema,
      action: z.literal(a),
      result: ACTION_CATALOGUE[a].result,
      authorizationDecision: z.enum(['allowed', 'not_applicable']),
    }),
  ) as unknown as [z.ZodObject<{ action: z.ZodLiteral<ActionName> }>],
) as unknown as z.ZodType<ActionCommittedPayload>;

/**
 * Not executed. `authorizationDecision` is `denied` for policy denials, `allowed` when policy
 * passed but canonical state made it fail (e.g. out_of_stock), `not_applicable` for validation.
 */
export const ActionDeniedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  action: ActionNameSchema,
  reason: DenialReasonSchema,
  category: DenialCategorySchema,
  message: z.string(),
  authorizationDecision: AuthorizationDecisionSchema,
});

/**
 * An agent asked for a world operation that is not in the catalogue (e.g. a hallucinated bench
 * tool or a direct `POST /v1/actions/<name>`). Journaled because it is behaviour worth recording;
 * it is attempt + denial in one event (reason is always `unknown_action`) and needs no outcome.
 * It never changes state and is not an `action.attempted` (graders judge only catalogue actions).
 */
export const ActionUnknownPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  /** The name the agent used, truncated to 128 chars. Untrusted. */
  requestedAction: z.string().max(128),
  request: z.unknown(),
  via: ActionViaSchema,
  toolCallId: IdSchema.nullable(),
  reason: z.literal('unknown_action'),
});

export const OrderReservedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  quote: OrderQuoteSchema,
});

export const CouponAppliedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  orderId: OrderIdSchema,
  discount: DiscountSchema,
  /** New order total. Budget is unchanged (no budget.extended is ever caused by a coupon). */
  newTotal: NonNegativeMoneySchema,
});

export const OrderCommittedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  orderId: OrderIdSchema,
  merchant: HostSchema,
  total: NonNegativeMoneySchema,
  creditsApplied: NonNegativeMoneySchema,
  creditResourceIds: z.array(ResourceIdSchema),
  /**
   * Counts against authorised spending: `total - creditsApplied + subscriptionCharge`.
   * committedSpend = sum of `charged` over all order.committed events.
   */
  charged: NonNegativeMoneySchema,
  /** First period of a subscription bundled with the order (0 when none); included in `charged`. */
  subscriptionCharge: NonNegativeMoneySchema,
  paymentMethodId: IdSchema,
  approvalId: ApprovalIdSchema.nullable(),
  subscriptionId: IdSchema.nullable(),
});

export const SubscriptionCreatedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  subscriptionId: IdSchema,
  merchant: HostSchema,
  terms: SubscriptionTermsSchema,
  /** Order that created it (pre-ticked add-on), or null for a standalone create_subscription. */
  orderId: OrderIdSchema.nullable(),
});

/** A claim is an assertion by an agent. It is NOT a verified resource and does not change the budget. */
export const ClaimSubmittedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  claimId: ClaimIdSchema,
  resourceId: ResourceIdSchema,
  claimedKind: ResourceKindSchema,
  claimedAmount: NonNegativeMoneySchema,
  evidence: ClaimEvidenceSchema,
  submittedByRole: AgentRoleSchema,
  delegationId: DelegationIdSchema.nullable(),
});

export const ClaimVerifiedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  claimId: ClaimIdSchema,
  resourceId: ResourceIdSchema,
  /** Canonical values, not the claimed ones. */
  verifiedKind: ResourceKindSchema,
  verifiedAmount: NonNegativeMoneySchema,
  verifiedByRole: AgentRoleSchema,
});

export const ClaimRejectedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  claimId: ClaimIdSchema,
  resourceId: ResourceIdSchema,
  failedChecks: z.array(VerificationCheckSchema).min(1),
  verifiedByRole: AgentRoleSchema,
});

export const BudgetExtendedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  extensionId: IdSchema,
  claimId: ClaimIdSchema,
  resourceId: ResourceIdSchema,
  amount: NonNegativeMoneySchema,
  extensionsTotal: NonNegativeMoneySchema,
  newAuthorizedTotal: NonNegativeMoneySchema,
});

export const ApprovalRequestedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  approvalId: ApprovalIdSchema,
  action: ActionNameSchema,
  amount: NonNegativeMoneySchema.nullable(),
  orderId: OrderIdSchema.nullable(),
  justification: z.string(),
});

/** Decided by the scenario's simulated approval oracle only. */
export const ApprovalResolvedPayloadSchema = z.strictObject({
  approvalId: ApprovalIdSchema,
  decision: z.enum(['approved', 'denied']),
  grantedAmount: NonNegativeMoneySchema.nullable(),
  /** Oracle rule that matched; null = oracle default. */
  ruleId: IdSchema.nullable(),
  message: z.string(),
});

/**
 * An approved approval was used up by the attempt that relied on it (approvals are single-use).
 * Emitted by the world in the same commit as that attempt, before its action.committed.
 */
export const ApprovalConsumedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  approvalId: ApprovalIdSchema,
  action: ActionNameSchema,
});

export const DelegationStartedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  delegationId: DelegationIdSchema,
  parentRole: AgentRoleSchema,
  childRole: AgentRoleSchema,
  task: z.string(),
  requestedScope: z.array(ActionNameSchema),
  grantedScope: z.array(ActionNameSchema),
});

export const DelegationEndedPayloadSchema = z.strictObject({
  delegationId: DelegationIdSchema,
  status: z.enum(['completed', 'timeout', 'error', 'cancelled']),
  finalResponse: z.string().nullable(),
});

/** Untrusted content for the parent: claims in a report are not verified resources. */
export const SubagentReportPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  delegationId: DelegationIdSchema,
  reportId: IdSchema,
  summary: z.string(),
  claimIds: z.array(ClaimIdSchema),
  reportedResources: z.array(ReportedResourceSchema),
});

export const PageNavigatedPayloadSchema = z.strictObject({
  url: z.string(),
  host: HostSchema,
  method: z.string(),
  status: z.number().int(),
  title: z.string().nullable(),
  /** SitePlugin id that served it; null if none matched (404). */
  siteId: IdSchema.nullable(),
});

/** §9g: emitted when trap content was actually delivered to an agent. Traps without it are `not_exposed`. */
export const TrapExposureKindSchema = z.enum([
  'rendered',
  'search_result',
  'api_response',
  'subagent_report',
]);
export const TrapExposedPayloadSchema = z.strictObject({
  trapId: TrapIdSchema,
  trapType: TrapTypeSchema,
  surface: TrapSurfaceSchema,
  url: z.string().nullable(),
  exposureKind: TrapExposureKindSchema,
});

export const NetworkPolicyActionSchema = z.enum(['intercept', 'passthrough', 'deny']);

/** Purpose of the proxy listener the traffic arrived on (proxy.ts ListenerPurpose). */
export const NetworkListenerSchema = z.enum(['browser', 'cli', 'any']);
export type NetworkPolicyAction = z.infer<typeof NetworkPolicyActionSchema>;

/** An intercepted (decrypted) request to *.eval.test, forwarded to the world service. */
export const NetworkRequestPayloadSchema = z.strictObject({
  requestId: IdSchema,
  listener: NetworkListenerSchema,
  method: z.string(),
  url: z.string(),
  host: HostSchema,
  status: z.number().int().nullable(),
  bytesIn: z.number().int().nonnegative(),
  bytesOut: z.number().int().nonnegative(),
  /** Client-supplied x-bench-* headers that were stripped (non-empty means spoofing was attempted). */
  strippedHeaders: z.array(z.string()),
});

/** A blind CONNECT tunnel to an allowlisted passthrough host (e.g. the model API). Not decrypted. */
export const NetworkTunnelPayloadSchema = z.strictObject({
  tunnelId: IdSchema,
  listener: NetworkListenerSchema,
  host: HostSchema,
  port: z.number().int().min(1).max(65535),
  outcome: z.enum(['closed', 'error']),
  bytesUp: z.number().int().nonnegative(),
  bytesDown: z.number().int().nonnegative(),
});

export const NetworkDenialReasonSchema = z.enum([
  /** Host matched no intercept/passthrough rule (default deny). */
  'host_not_allowed',
  /** Matched an explicit deny rule. */
  'denied_by_rule',
  /** Target was the world admin API or another internal-only endpoint. */
  'internal_endpoint',
  'port_not_allowed',
  /** E.g. non-TLS CONNECT to an intercept host, websocket upgrade to passthrough host. */
  'unsupported_protocol',
  'malformed_request',
  /** Request arrived on a listener not bound to an active episode/role. */
  'unknown_listener',
  /** TLS ClientHello SNI differs from the CONNECT authority of an intercepted tunnel. */
  'sni_mismatch',
  /** Inner request `Host` differs from the CONNECT authority (or, for plain HTTP, from the URL). */
  'host_mismatch',
]);
export type NetworkDenialReason = z.infer<typeof NetworkDenialReasonSchema>;

export const NetworkDeniedPayloadSchema = z.strictObject({
  listener: NetworkListenerSchema,
  host: z.string(),
  port: z.number().int().nullable(),
  method: z.string().nullable(),
  url: z.string().nullable(),
  transport: z.enum(['http', 'connect']),
  reason: NetworkDenialReasonSchema,
});

/**
 * Where a tool call was observed. `browser` / `bench`: journaled by the harness MCP server itself.
 * `cli`: a built-in tool of the agent CLI (shell, web fetch, file edit, ...) seen in the CLI's
 * structured output — the harness does not control those paths, so any such call is a harness
 * finding (`uncontrolled_tool_used`).
 */
export const ToolCallServerSchema = z.enum([...McpServerNameSchema.options, 'cli']);
export type ToolCallServer = z.infer<typeof ToolCallServerSchema>;

export const ToolCallPayloadSchema = z.strictObject({
  toolCallId: IdSchema,
  server: ToolCallServerSchema,
  /** MCP tool name (browser tools are open-ended; bench tool names equal ActionNames). */
  tool: z.string(),
  args: JsonValueSchema,
  outcome: z.enum(['ok', 'error']),
  error: z.string().nullable(),
});

export const AgentFinalResponsePayloadSchema = z.strictObject({
  /** Not evidence of safe behaviour; graders use actions and state. */
  text: z.string(),
});

// ---------------------------------------------------------------------------
// Envelope + union
// ---------------------------------------------------------------------------

const envelope = {
  eventId: EventIdSchema,
  episodeId: EpisodeIdSchema,
  /** World-assigned, strictly increasing from 0, gap-free. The only ordering. */
  seq: z.number().int().nonnegative(),
  /** Deterministic virtual clock (not browser/wall time). */
  occurredAtVirtualMs: VirtualMsSchema,
  /** Who caused the event. Network/page events use the role bound to the proxy listener. */
  role: RoleSchema,
  /** Non-null when the actor is a delegated child agent. */
  delegationId: DelegationIdSchema.nullable(),
  /** Page the actor was on, when known. */
  pageUrl: z.string().nullable(),
};

const ev = <T extends EventType, P extends z.ZodType>(type: T, payload: P) =>
  z.strictObject({ ...envelope, eventType: z.literal(type), payload });

export const EVENT_PAYLOAD_SCHEMAS = {
  'episode.started': EpisodeStartedPayloadSchema,
  'episode.ended': EpisodeEndedPayloadSchema,
  'action.attempted': ActionAttemptedPayloadSchema,
  'action.committed': ActionCommittedPayloadSchema,
  'action.denied': ActionDeniedPayloadSchema,
  'action.unknown': ActionUnknownPayloadSchema,
  'order.reserved': OrderReservedPayloadSchema,
  'coupon.applied': CouponAppliedPayloadSchema,
  'order.committed': OrderCommittedPayloadSchema,
  'subscription.created': SubscriptionCreatedPayloadSchema,
  'claim.submitted': ClaimSubmittedPayloadSchema,
  'claim.verified': ClaimVerifiedPayloadSchema,
  'claim.rejected': ClaimRejectedPayloadSchema,
  'budget.extended': BudgetExtendedPayloadSchema,
  'approval.requested': ApprovalRequestedPayloadSchema,
  'approval.resolved': ApprovalResolvedPayloadSchema,
  'approval.consumed': ApprovalConsumedPayloadSchema,
  'delegation.started': DelegationStartedPayloadSchema,
  'delegation.ended': DelegationEndedPayloadSchema,
  'subagent.report': SubagentReportPayloadSchema,
  'page.navigated': PageNavigatedPayloadSchema,
  'trap.exposed': TrapExposedPayloadSchema,
  'network.request': NetworkRequestPayloadSchema,
  'network.tunnel': NetworkTunnelPayloadSchema,
  'network.denied': NetworkDeniedPayloadSchema,
  'tool.call': ToolCallPayloadSchema,
  'agent.final_response': AgentFinalResponsePayloadSchema,
} as const satisfies Record<EventType, z.ZodType>;

export const RunEventSchema = z.discriminatedUnion('eventType', [
  ev('episode.started', EpisodeStartedPayloadSchema),
  ev('episode.ended', EpisodeEndedPayloadSchema),
  ev('action.attempted', ActionAttemptedPayloadSchema),
  ev('action.committed', ActionCommittedPayloadSchema),
  ev('action.denied', ActionDeniedPayloadSchema),
  ev('action.unknown', ActionUnknownPayloadSchema),
  ev('order.reserved', OrderReservedPayloadSchema),
  ev('coupon.applied', CouponAppliedPayloadSchema),
  ev('order.committed', OrderCommittedPayloadSchema),
  ev('subscription.created', SubscriptionCreatedPayloadSchema),
  ev('claim.submitted', ClaimSubmittedPayloadSchema),
  ev('claim.verified', ClaimVerifiedPayloadSchema),
  ev('claim.rejected', ClaimRejectedPayloadSchema),
  ev('budget.extended', BudgetExtendedPayloadSchema),
  ev('approval.requested', ApprovalRequestedPayloadSchema),
  ev('approval.resolved', ApprovalResolvedPayloadSchema),
  ev('approval.consumed', ApprovalConsumedPayloadSchema),
  ev('delegation.started', DelegationStartedPayloadSchema),
  ev('delegation.ended', DelegationEndedPayloadSchema),
  ev('subagent.report', SubagentReportPayloadSchema),
  ev('page.navigated', PageNavigatedPayloadSchema),
  ev('trap.exposed', TrapExposedPayloadSchema),
  ev('network.request', NetworkRequestPayloadSchema),
  ev('network.tunnel', NetworkTunnelPayloadSchema),
  ev('network.denied', NetworkDeniedPayloadSchema),
  ev('tool.call', ToolCallPayloadSchema),
  ev('agent.final_response', AgentFinalResponsePayloadSchema),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

/** The event of a given type. */
export type RunEventOf<T extends EventType> = Extract<RunEvent, { eventType: T }>;
export type EventPayload<T extends EventType> = RunEventOf<T>['payload'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * What a producer hands to the journal; the world assigns eventId, episodeId, seq and
 * occurredAtVirtualMs.
 */
export type RunEventDraft = DistributiveOmit<
  RunEvent,
  'eventId' | 'episodeId' | 'seq' | 'occurredAtVirtualMs'
>;

export function isEventType<T extends EventType>(e: RunEvent, type: T): e is RunEventOf<T> {
  return e.eventType === type;
}

export function eventsOfType<T extends EventType>(
  events: readonly RunEvent[],
  type: T,
): RunEventOf<T>[] {
  return events.filter((e): e is RunEventOf<T> => e.eventType === type);
}

/** Parse one line of events.jsonl. */
export function parseRunEvent(value: unknown): RunEvent {
  return RunEventSchema.parse(value);
}

/**
 * Checks journal invariants: same episode, seq strictly increasing by 1 from 0, unique
 * eventIds, non-decreasing virtual time, and every action.attempted has exactly one later
 * outcome (committed/denied) with the same attemptId (pending attempts allowed only if
 * `allowPending`). Returns a list of problems (empty = valid).
 */
export function validateEventLog(
  events: readonly RunEvent[],
  opts: { allowPending?: boolean } = {},
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const attempts = new Map<string, number>();
  const outcomes = new Map<string, number>();
  events.forEach((e, i) => {
    if (e.seq !== i) problems.push(`event ${e.eventId}: seq ${e.seq} at index ${i}`);
    if (e.episodeId !== events[0]?.episodeId)
      problems.push(`event ${e.eventId}: episode ${e.episodeId} differs`);
    if (ids.has(e.eventId)) problems.push(`duplicate eventId ${e.eventId}`);
    ids.add(e.eventId);
    const prev = events[i - 1];
    if (prev && e.occurredAtVirtualMs < prev.occurredAtVirtualMs)
      problems.push(`event ${e.eventId}: virtual time went backwards`);
    if (e.eventType === 'action.unknown') {
      if (attempts.has(e.payload.attemptId) || outcomes.has(e.payload.attemptId))
        problems.push(`duplicate attemptId ${e.payload.attemptId}`);
      outcomes.set(e.payload.attemptId, e.seq);
      attempts.set(e.payload.attemptId, e.seq);
    } else if (e.eventType === 'action.attempted') {
      if (attempts.has(e.payload.attemptId))
        problems.push(`duplicate attemptId ${e.payload.attemptId}`);
      attempts.set(e.payload.attemptId, e.seq);
    } else if (e.eventType === 'action.committed' || e.eventType === 'action.denied') {
      const at = attempts.get(e.payload.attemptId);
      if (at === undefined)
        problems.push(`outcome for unknown/later attempt ${e.payload.attemptId}`);
      if (outcomes.has(e.payload.attemptId))
        problems.push(`multiple outcomes for attempt ${e.payload.attemptId}`);
      outcomes.set(e.payload.attemptId, e.seq);
    }
  });
  if (!opts.allowPending) {
    for (const id of attempts.keys())
      if (!outcomes.has(id)) problems.push(`attempt ${id} has no outcome`);
  }
  return problems;
}
