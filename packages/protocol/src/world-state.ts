import { z } from 'zod';
import { ActionNameSchema } from './actions.js';
import { DiscountSchema, FeeSchema, OrderLineSchema, SubscriptionTermsSchema } from './actions.js';
import {
  AgentRoleSchema,
  ApprovalIdSchema,
  AttemptIdSchema,
  ClaimIdSchema,
  DelegationIdSchema,
  EpisodeIdSchema,
  EvalHostSchema,
  IdSchema,
  OrderIdSchema,
  ResourceIdSchema,
  RoleSchema,
  SkuSchema,
  VirtualMsSchema,
} from './common.js';
import { DenialReasonSchema } from './denials.js';
import { MoneySchema, NonNegativeMoneySchema } from './money.js';
import { AccountSchema, ResourceSchema } from './scenario.js';
import { VerificationCheckSchema } from './resources.js';

/**
 * Canonical state of a resource during an episode: the fixture truth plus usage.
 * Listed under funds / credits / coupons / refunds by RESOURCE_KIND_PROJECTION.
 */
export const ResourceStateSchema = ResourceSchema.extend({
  /** Amount consumed (credits applied, coupons redeemed, reserve backing an extension). */
  usedAmount: NonNegativeMoneySchema,
  status: z.enum(['available', 'partially_used', 'used', 'unavailable']),
});
export type ResourceState = z.infer<typeof ResourceStateSchema>;

export const OrderStateSchema = z.strictObject({
  orderId: OrderIdSchema,
  merchant: EvalHostSchema,
  role: AgentRoleSchema,
  status: z.enum(['reserved', 'committed', 'expired']),
  lines: z.array(OrderLineSchema),
  subtotal: NonNegativeMoneySchema,
  discounts: z.array(DiscountSchema),
  fees: z.array(FeeSchema),
  total: NonNegativeMoneySchema,
  subscription: SubscriptionTermsSchema.nullable(),
  /** Set once committed. */
  charged: NonNegativeMoneySchema.nullable(),
  creditsApplied: NonNegativeMoneySchema.nullable(),
  paymentMethodId: IdSchema.nullable(),
  approvalId: ApprovalIdSchema.nullable(),
  reservedAttemptId: AttemptIdSchema,
  committedAttemptId: AttemptIdSchema.nullable(),
});
export type OrderState = z.infer<typeof OrderStateSchema>;

export const SubscriptionStateSchema = z.strictObject({
  subscriptionId: IdSchema,
  merchant: EvalHostSchema,
  terms: SubscriptionTermsSchema,
  orderId: OrderIdSchema.nullable(),
  status: z.enum(['active', 'cancelled']),
  createdAttemptId: AttemptIdSchema,
});
export type SubscriptionState = z.infer<typeof SubscriptionStateSchema>;

export const ApprovalStateSchema = z.strictObject({
  approvalId: ApprovalIdSchema,
  role: AgentRoleSchema,
  action: ActionNameSchema,
  requestedAmount: NonNegativeMoneySchema.nullable(),
  orderId: OrderIdSchema.nullable(),
  justification: z.string(),
  decision: z.enum(['approved', 'denied']),
  grantedAmount: NonNegativeMoneySchema.nullable(),
  /** An approved approval is single-use; set when consumed by the action it approved. */
  consumedByAttemptId: AttemptIdSchema.nullable(),
});
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const DelegationStateSchema = z.strictObject({
  delegationId: DelegationIdSchema,
  parentRole: AgentRoleSchema,
  childRole: AgentRoleSchema,
  task: z.string(),
  grantedScope: z.array(ActionNameSchema),
  status: z.enum(['active', 'completed', 'timeout', 'error', 'cancelled']),
  reportIds: z.array(IdSchema),
});
export type DelegationState = z.infer<typeof DelegationStateSchema>;

/**
 * A claim is what an agent ASSERTED about a resource; verification records what the world found.
 * Only `status: 'verified'` claims can back a budget extension.
 */
export const ClaimStateSchema = z.strictObject({
  claimId: ClaimIdSchema,
  resourceId: ResourceIdSchema,
  submittedByRole: AgentRoleSchema,
  delegationId: DelegationIdSchema.nullable(),
  claimedKind: ResourceSchema.shape.kind,
  claimedAmount: NonNegativeMoneySchema,
  status: z.enum(['pending_verification', 'verified', 'rejected']),
  verifiedAmount: NonNegativeMoneySchema.nullable(),
  failedChecks: z.array(VerificationCheckSchema),
  /** Extension that consumed it, if any (a claim backs at most one extension). */
  usedByExtensionId: IdSchema.nullable(),
});
export type ClaimState = z.infer<typeof ClaimStateSchema>;

export const BudgetExtensionStateSchema = z.strictObject({
  extensionId: IdSchema,
  claimId: ClaimIdSchema,
  resourceId: ResourceIdSchema,
  amount: NonNegativeMoneySchema,
  attemptId: AttemptIdSchema,
});
export type BudgetExtensionState = z.infer<typeof BudgetExtensionStateSchema>;

/** Spending authority. Coupons and unverified claims never appear here. */
export const AuthorizationStateSchema = z.strictObject({
  baseBudget: NonNegativeMoneySchema,
  maxAdditionalBudget: NonNegativeMoneySchema,
  extensions: z.array(BudgetExtensionStateSchema),
  extensionsTotal: NonNegativeMoneySchema,
  /** baseBudget + extensionsTotal. */
  authorizedTotal: NonNegativeMoneySchema,
  /** Sum of `charged` over committed orders (+ committed subscriptions' first charge, if any). */
  committedSpend: NonNegativeMoneySchema,
  /** authorizedTotal - committedSpend (negative only if an approval allowed exceeding it). */
  remaining: MoneySchema,
});
export type AuthorizationState = z.infer<typeof AuthorizationStateSchema>;

/** Projection of one attempt and its outcome (attemptId links to the journal). */
export const AttemptStateSchema = z.strictObject({
  attemptId: AttemptIdSchema,
  seq: z.number().int().nonnegative(),
  role: RoleSchema,
  delegationId: DelegationIdSchema.nullable(),
  action: ActionNameSchema,
  status: z.enum(['pending', 'committed', 'denied']),
  denialReason: DenialReasonSchema.nullable(),
  outcomeSeq: z.number().int().nonnegative().nullable(),
});
export type AttemptState = z.infer<typeof AttemptStateSchema>;

/**
 * Full world projection (spec §6), as dumped to `world-final.json` and given to graders as
 * initialState / finalState. Arrays are sorted by id (or seq for attempts) for determinism.
 */
export const WorldStateSchema = z.strictObject({
  episodeId: EpisodeIdSchema,
  /** seq of the last event applied; -1 before any event. */
  asOfSeq: z.number().int().min(-1),
  virtualNowMs: VirtualMsSchema,
  accounts: z.array(AccountSchema),
  /** settled_reserve_cash, future_cashback, credit_line, other_user_funds, rewards_points. */
  funds: z.array(ResourceStateSchema),
  /** merchant_credit, gift_card. */
  credits: z.array(ResourceStateSchema),
  coupons: z.array(ResourceStateSchema),
  /** pending_refund, settled_refund. */
  refunds: z.array(ResourceStateSchema),
  orders: z.array(OrderStateSchema),
  subscriptions: z.array(SubscriptionStateSchema),
  approvals: z.array(ApprovalStateSchema),
  delegations: z.array(DelegationStateSchema),
  claims: z.array(ClaimStateSchema),
  authorizations: AuthorizationStateSchema,
  attempts: z.array(AttemptStateSchema),
  /** Products with current stock (read-only in MVP). */
  inventory: z.array(
    z.strictObject({ sku: SkuSchema, merchant: EvalHostSchema, inStock: z.boolean() }),
  ),
});
export type WorldState = z.infer<typeof WorldStateSchema>;
