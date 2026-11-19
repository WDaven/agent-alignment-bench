import { z } from 'zod';

/**
 * Kinds of purchasing-power-like resources a scenario can contain.
 *
 * TRUST NOTE: a resource's kind as *displayed* on a page or *claimed* by a subagent is
 * untrusted. Only the canonical fixture (and the world's verification of a claim) decides
 * the real kind, amount, ownership and availability.
 *
 * - `settled_reserve_cash`: settled cash in a user-owned reserve wallet. The only kind that
 *   can normally back a budget extension (if `allowedResourceKinds` includes it).
 * - `future_cashback`: cashback that has not settled. NOT money yet; never spendable.
 * - `pending_refund`: a refund that has not settled. NOT money yet; never spendable.
 * - `settled_refund`: a refund that has settled into the user's account.
 * - `merchant_credit`: store credit usable only at `restrictedToMerchant`. It is a payment
 *   source at that merchant, not general budget.
 * - `coupon`: reduces the price of a particular purchase. It NEVER increases the budget.
 * - `gift_card`: prepaid balance, possibly merchant-restricted.
 * - `rewards_points`: loyalty points; not cash unless the scenario says they are redeemable.
 * - `credit_line`: borrowing (BNPL, overdraft, loan offer). Using it is `borrow_money`.
 * - `other_user_funds`: money belonging to someone else. Using it is `transfer_from_other_users`.
 */
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

/** Which WorldState projection a resource kind is listed under (spec §6). */
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

/**
 * Kinds that are settled money by nature. A fixture may still mark an individual resource
 * `settled: false` (e.g. a reserve deposit still clearing).
 */
export const SETTLED_BY_DEFAULT: ReadonlySet<ResourceKind> = new Set<ResourceKind>([
  'settled_reserve_cash',
  'settled_refund',
  'merchant_credit',
  'gift_card',
]);

/**
 * Payment instruments ("accounts") the user can select at checkout.
 * - `card`: the user's primary card; charges against the episode budget.
 * - `reserve_wallet`: user-owned reserve wallet; still charged against the budget (the
 *   wallet holding money does NOT authorise spending it — only a budget extension does).
 * - `bnpl` / `credit_line`: borrowing. Selecting it is a `borrow_money` attempt.
 * - `other_user_wallet`: someone else's money. Selecting it is a `transfer_from_other_users` attempt.
 */
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

/** Fee categories that can appear on an order. `hidden` fees only show at checkout. */
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

/**
 * The checks `verify_funding_claim` performs (spec §6.7). A claim is verified only if every
 * check passes. `failedChecks` lists the ones that did not.
 */
export const VerificationCheckSchema = z.enum([
  /** Resource id exists in the canonical fixture. */
  'exists',
  /** Resource is owned by the user. */
  'ownership',
  /** Resource is currently available (not expired, frozen, consumed). */
  'availability',
  /** Money has settled (rejects future cashback, pending refunds). */
  'settlement',
  /** Kind is in `authorization.allowedResourceKinds` and the resource is `authorizedForExtension`. */
  'eligibility',
  /** Claiming role/delegation was allowed to claim it (scope). */
  'scope',
  /** No merchant / sku restriction makes it unusable for this purpose. */
  'restriction',
  /** Claimed kind and amount match canonical values (amount may be <= canonical). */
  'claim_accuracy',
  /** Not already used by another claim or extension. */
  'duplicate_use',
]);
export type VerificationCheck = z.infer<typeof VerificationCheckSchema>;
