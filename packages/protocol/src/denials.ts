import { z } from 'zod';

export const DenialReasonSchema = z.enum([
  'action_forbidden',
  'action_not_allowed',
  'scope_violation',
  'approval_required',
  'exceeds_authorized_budget',
  'exceeds_max_additional_budget',
  'resource_kind_not_allowed',
  'claim_not_verified',
  'merchant_not_allowed',
  'payment_method_not_allowed',
  'subscription_not_allowed',
  'delegation_scope_exceeded',
  'policy_immutable',

  'claim_not_found',
  'claim_already_used',
  'resource_not_found',
  'resource_not_owned',
  'resource_not_available',
  'resource_not_settled',
  'resource_restricted',
  'coupon_invalid',
  'coupon_expired',
  'coupon_not_applicable',
  'order_not_found',
  'order_already_committed',
  'order_expired',
  'sku_not_found',
  'out_of_stock',
  'insufficient_funds',
  'delegation_not_found',
  'delegation_not_active',
  'approval_not_found',

  'invalid_request',
  'unknown_action',

  'episode_not_active',
  'step_limit_exceeded',
  'internal_error',
]);
export type DenialReason = z.infer<typeof DenialReasonSchema>;
export const DENIAL_REASONS = DenialReasonSchema.options;

export const DenialCategorySchema = z.enum(['policy', 'world_state', 'validation', 'system']);
export type DenialCategory = z.infer<typeof DenialCategorySchema>;

export const DENIAL_REASON_CATEGORY: Readonly<Record<DenialReason, DenialCategory>> = {
  action_forbidden: 'policy',
  action_not_allowed: 'policy',
  scope_violation: 'policy',
  approval_required: 'policy',
  exceeds_authorized_budget: 'policy',
  exceeds_max_additional_budget: 'policy',
  resource_kind_not_allowed: 'policy',
  claim_not_verified: 'policy',
  merchant_not_allowed: 'policy',
  payment_method_not_allowed: 'policy',
  subscription_not_allowed: 'policy',
  delegation_scope_exceeded: 'policy',
  policy_immutable: 'policy',
  claim_not_found: 'world_state',
  claim_already_used: 'world_state',
  resource_not_found: 'world_state',
  resource_not_owned: 'world_state',
  resource_not_available: 'world_state',
  resource_not_settled: 'world_state',
  resource_restricted: 'world_state',
  coupon_invalid: 'world_state',
  coupon_expired: 'world_state',
  coupon_not_applicable: 'world_state',
  order_not_found: 'world_state',
  order_already_committed: 'world_state',
  order_expired: 'world_state',
  sku_not_found: 'world_state',
  out_of_stock: 'world_state',
  insufficient_funds: 'world_state',
  delegation_not_found: 'world_state',
  delegation_not_active: 'world_state',
  approval_not_found: 'world_state',
  invalid_request: 'validation',
  unknown_action: 'validation',
  episode_not_active: 'system',
  step_limit_exceeded: 'system',
  internal_error: 'system',
};

export const DenialSchema = z.strictObject({
  reason: DenialReasonSchema,
  message: z.string(),
});
export type Denial = z.infer<typeof DenialSchema>;
