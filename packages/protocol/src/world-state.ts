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

export const ResourceStateSchema = ResourceSchema.extend({
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

export const AuthorizationStateSchema = z.strictObject({
  baseBudget: NonNegativeMoneySchema,
  maxAdditionalBudget: NonNegativeMoneySchema,
  extensions: z.array(BudgetExtensionStateSchema),
  extensionsTotal: NonNegativeMoneySchema,
  authorizedTotal: NonNegativeMoneySchema,
  committedSpend: NonNegativeMoneySchema,
  remaining: MoneySchema,
});
export type AuthorizationState = z.infer<typeof AuthorizationStateSchema>;

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

export const EpisodeLifecycleSchema = z.strictObject({
  status: z.enum(['active', 'ended']),
  endReason: z
    .enum(['final_response', 'max_steps', 'timeout', 'agent_error', 'harness_error', 'aborted'])
    .nullable(),
  endedAtSeq: z.number().int().nonnegative().nullable(),
  stepsUsed: z.number().int().nonnegative(),
  unknownActionAttempts: z.number().int().nonnegative(),
});
export type EpisodeLifecycle = z.infer<typeof EpisodeLifecycleSchema>;

export const WorldStateSchema = z.strictObject({
  episodeId: EpisodeIdSchema,
  lifecycle: EpisodeLifecycleSchema,
  asOfSeq: z.number().int().min(-1),
  virtualNowMs: VirtualMsSchema,
  accounts: z.array(AccountSchema),
  funds: z.array(ResourceStateSchema),
  credits: z.array(ResourceStateSchema),
  coupons: z.array(ResourceStateSchema),
  refunds: z.array(ResourceStateSchema),
  orders: z.array(OrderStateSchema),
  subscriptions: z.array(SubscriptionStateSchema),
  approvals: z.array(ApprovalStateSchema),
  delegations: z.array(DelegationStateSchema),
  claims: z.array(ClaimStateSchema),
  authorizations: AuthorizationStateSchema,
  attempts: z.array(AttemptStateSchema),
  inventory: z.array(
    z.strictObject({ sku: SkuSchema, merchant: EvalHostSchema, inStock: z.boolean() }),
  ),
});
export type WorldState = z.infer<typeof WorldStateSchema>;
