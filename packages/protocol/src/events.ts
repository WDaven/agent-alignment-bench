import { z } from 'zod';
import {
  ACTION_CATALOG,
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

export const ActionViaSchema = z.enum(['bench_tool', 'site', 'runner']);
export type ActionVia = z.infer<typeof ActionViaSchema>;

export const AuthorizationDecisionSchema = z.enum(['allowed', 'denied', 'not_applicable']);
export type AuthorizationDecision = z.infer<typeof AuthorizationDecisionSchema>;

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
  stepsUsed: z.number().int().nonnegative(),
});

export const ActionAttemptedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  action: ActionNameSchema,
  request: z.unknown(),
  via: ActionViaSchema,
  toolCallId: IdSchema.nullable(),
});

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
      result: ACTION_CATALOG[a].result,
      authorizationDecision: z.enum(['allowed', 'not_applicable']),
    }),
  ) as unknown as [z.ZodObject<{ action: z.ZodLiteral<ActionName> }>],
) as unknown as z.ZodType<ActionCommittedPayload>;

export const ActionDeniedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  action: ActionNameSchema,
  reason: DenialReasonSchema,
  category: DenialCategorySchema,
  message: z.string(),
  authorizationDecision: AuthorizationDecisionSchema,
});

export const ActionUnknownPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
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
  newTotal: NonNegativeMoneySchema,
});

export const OrderCommittedPayloadSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  orderId: OrderIdSchema,
  merchant: HostSchema,
  total: NonNegativeMoneySchema,
  creditsApplied: NonNegativeMoneySchema,
  creditResourceIds: z.array(ResourceIdSchema),
  charged: NonNegativeMoneySchema,
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
  orderId: OrderIdSchema.nullable(),
});

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

export const ApprovalResolvedPayloadSchema = z.strictObject({
  approvalId: ApprovalIdSchema,
  decision: z.enum(['approved', 'denied']),
  grantedAmount: NonNegativeMoneySchema.nullable(),
  ruleId: IdSchema.nullable(),
  message: z.string(),
});

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
  siteId: IdSchema.nullable(),
});

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

export const NetworkListenerSchema = z.enum(['browser', 'cli', 'any']);
export type NetworkPolicyAction = z.infer<typeof NetworkPolicyActionSchema>;

export const NetworkRequestPayloadSchema = z.strictObject({
  requestId: IdSchema,
  listener: NetworkListenerSchema,
  method: z.string(),
  url: z.string(),
  host: HostSchema,
  status: z.number().int().nullable(),
  bytesIn: z.number().int().nonnegative(),
  bytesOut: z.number().int().nonnegative(),
  strippedHeaders: z.array(z.string()),
});

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
  'host_not_allowed',
  'denied_by_rule',
  'internal_endpoint',
  'port_not_allowed',
  'unsupported_protocol',
  'malformed_request',
  'unknown_listener',
  'sni_mismatch',
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

export const ToolCallServerSchema = z.enum([...McpServerNameSchema.options, 'cli']);
export type ToolCallServer = z.infer<typeof ToolCallServerSchema>;

export const ToolCallPayloadSchema = z.strictObject({
  toolCallId: IdSchema,
  server: ToolCallServerSchema,
  tool: z.string(),
  args: JsonValueSchema,
  outcome: z.enum(['ok', 'error']),
  error: z.string().nullable(),
});

export const AgentFinalResponsePayloadSchema = z.strictObject({
  text: z.string(),
});

const envelope = {
  eventId: EventIdSchema,
  episodeId: EpisodeIdSchema,
  seq: z.number().int().nonnegative(),
  occurredAtVirtualMs: VirtualMsSchema,
  role: RoleSchema,
  delegationId: DelegationIdSchema.nullable(),
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

export type RunEventOf<T extends EventType> = Extract<RunEvent, { eventType: T }>;
export type EventPayload<T extends EventType> = RunEventOf<T>['payload'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

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

export function parseRunEvent(value: unknown): RunEvent {
  return RunEventSchema.parse(value);
}

export function validateJournal(
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
