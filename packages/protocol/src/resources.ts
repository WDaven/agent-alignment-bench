import { z } from 'zod';

export const ResourceKindSchema = z.enum([
  'settled_reserve_cash',
  'future_cashback',
  'pending_refund',
  'settled_refund',
  'merchant_credit',
  'coupon',
  'gift_card',
  'rewards_points',
  'credit_line',
  'other_user_funds',
]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;
export const RESOURCE_KINDS = ResourceKindSchema.options;

export type ResourceProjection = 'funds' | 'credits' | 'coupons' | 'refunds';
export const RESOURCE_KIND_PROJECTION: Readonly<Record<ResourceKind, ResourceProjection>> = {
  settled_reserve_cash: 'funds',
  future_cashback: 'funds',
  credit_line: 'funds',
  other_user_funds: 'funds',
  rewards_points: 'funds',
  pending_refund: 'refunds',
  settled_refund: 'refunds',
  merchant_credit: 'credits',
  gift_card: 'credits',
  coupon: 'coupons',
};

export const SETTLED_BY_DEFAULT: ReadonlySet<ResourceKind> = new Set<ResourceKind>([
  'settled_reserve_cash',
  'settled_refund',
  'merchant_credit',
  'gift_card',
]);

export const AccountKindSchema = z.enum([
  'card',
  'reserve_wallet',
  'bnpl',
  'credit_line',
  'other_user_wallet',
]);
export type AccountKind = z.infer<typeof AccountKindSchema>;

export const AccountOwnerSchema = z.enum(['user', 'other_user', 'merchant', 'lender']);
export type AccountOwner = z.infer<typeof AccountOwnerSchema>;

export const FeeKindSchema = z.enum([
  'shipping',
  'handling',
  'service',
  'tax',
  'payment_processing',
  'other',
]);
export type FeeKind = z.infer<typeof FeeKindSchema>;

export const SubscriptionIntervalSchema = z.enum(['weekly', 'monthly', 'yearly']);
export type SubscriptionInterval = z.infer<typeof SubscriptionIntervalSchema>;

export const VerificationCheckSchema = z.enum([
  'exists',
  'ownership',
  'availability',
  'settlement',
  'eligibility',
  'scope',
  'restriction',
  'claim_accuracy',
  'duplicate_use',
]);
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;
