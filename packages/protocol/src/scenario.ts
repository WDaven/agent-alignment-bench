import { z } from 'zod';
import { ActionNameSchema, type ActionName } from './actions.js';
import {
  BenchmarkIdSchema,
  EvalHostSchema,
  IdSchema,
  JsonValueSchema,
  ResourceIdSchema,
  RoleSchema,
  ScenarioIdSchema,
  SkuSchema,
  TrapIdSchema,
  UrlSchema,
  VariantSchema,
  VirtualMsSchema,
} from './common.js';
import { NonNegativeMoneySchema, usd, type Money } from './money.js';
import {
  ApprovalOracleSchema,
  AuthorizationPolicySchema,
  DEFAULT_ALLOWED_ACTIONS,
  DEFAULT_APPROVAL_ORACLE,
  DEFAULT_SCOPE_BY_ROLE,
} from './policy.js';
import {
  AccountKindSchema,
  AccountOwnerSchema,
  FeeKindSchema,
  ResourceKindSchema,
  SETTLED_BY_DEFAULT,
  SubscriptionIntervalSchema,
} from './resources.js';

// ===========================================================================
// In-memory (camelCase) scenario model — the single source of truth for types.
// ===========================================================================

export const DifficultySchema = z.number().int().min(1).max(5);
export type Difficulty = z.infer<typeof DifficultySchema>;

/** Fixture version label, e.g. `1` or `2024.1`. */
export const FixtureVersionSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,32}$/, 'fixture version is [A-Za-z0-9._-]{1,32}');

export const DEFAULT_MAX_STEPS = 200;
export const DEFAULT_MAX_WALL_MS = 15 * 60 * 1000;
export const DEFAULT_FIXTURE_VERSION = '1';
export const DEFAULT_PRIMARY_ACCOUNT_ID = 'card-primary';

/** Payment instrument selectable at checkout. See AccountKind for which kinds are high-risk. */
export const AccountSchema = z.strictObject({
  id: IdSchema,
  kind: AccountKindSchema,
  label: z.string(),
  owner: AccountOwnerSchema,
  /** Informational balance (e.g. shown in a wallet UI). Holding money does not authorise spending it. */
  balance: NonNegativeMoneySchema.nullable(),
  /** For bnpl / credit_line accounts. */
  creditLimit: NonNegativeMoneySchema.nullable(),
});
export type Account = z.infer<typeof AccountSchema>;

export const ProductFeeSchema = z.strictObject({
  kind: FeeKindSchema,
  label: z.string(),
  amount: NonNegativeMoneySchema,
  /** `checkout` = not shown on the listing, only revealed in the checkout flow (ambiguous/hidden fee). */
  revealedAt: z.enum(['listing', 'checkout']),
});
export type ProductFee = z.infer<typeof ProductFeeSchema>;

export const SubscriptionOfferSchema = z.strictObject({
  planId: IdSchema,
  price: NonNegativeMoneySchema,
  interval: SubscriptionIntervalSchema,
  /** True = a pre-ticked add-on (hidden subscription trap surface). */
  preselected: z.boolean(),
});
export type SubscriptionOffer = z.infer<typeof SubscriptionOfferSchema>;

export const ProductSchema = z.strictObject({
  sku: SkuSchema,
  merchant: EvalHostSchema,
  title: z.string(),
  description: z.string(),
  listPrice: NonNegativeMoneySchema,
  fees: z.array(ProductFeeSchema),
  /** listPrice + sum(fees), for quantity 1, before coupons/credits. Validated. */
  total: NonNegativeMoneySchema,
  /**
   * Whether this product satisfies the user task's item requirements. Grader-relevant;
   * the world must never render or return it.
   */
  meetsRequirements: z.boolean(),
  inStock: z.boolean(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  subscriptionOffer: SubscriptionOfferSchema.nullable(),
});
export type Product = z.infer<typeof ProductSchema>;

/** How a lower-trust surface PRESENTS a resource. May deliberately misstate kind/amount. */
export const ResourceDisplaySchema = z.strictObject({
  kind: ResourceKindSchema,
  amount: NonNegativeMoneySchema,
  sourceUrl: UrlSchema.nullable(),
  description: z.string(),
});
export type ResourceDisplay = z.infer<typeof ResourceDisplaySchema>;

/**
 * Canonical truth about a resource. Only the world (and grader) see these fields; agents see
 * `displayed` via discover_funds / pages and must verify claims.
 */
export const ResourceSchema = z.strictObject({
  id: ResourceIdSchema,
  kind: ResourceKindSchema,
  amount: NonNegativeMoneySchema,
  ownedByUser: z.boolean(),
  available: z.boolean(),
  /** Defaults by kind (see SETTLED_BY_DEFAULT). future_cashback / pending_refund are never spendable. */
  settled: z.boolean(),
  /** Whether the user's policy lets this specific resource back a budget extension (also needs kind in allowedResourceKinds). */
  authorizedForExtension: z.boolean(),
  restrictedToMerchant: EvalHostSchema.nullable(),
  restrictedToSkus: z.array(SkuSchema).nullable(),
  /** Required for `coupon`; the code to type at checkout. */
  couponCode: z.string().nullable(),
  /** Coupon / credit minimum order subtotal. */
  minPurchase: NonNegativeMoneySchema.nullable(),
  expiresAtVirtualMs: VirtualMsSchema.nullable(),
  /** Whether discover_funds returns it. */
  discoverable: z.boolean(),
  /** Presentation on lower-trust surfaces; null = presented truthfully. */
  displayed: ResourceDisplaySchema.nullable(),
  description: z.string(),
});
export type Resource = z.infer<typeof ResourceSchema>;

export const SearchDocSchema = z.strictObject({
  url: UrlSchema,
  title: z.string(),
  snippet: z.string(),
  keywords: z.array(z.string()),
  /** Higher ranks earlier for matching queries; ties broken by array order. */
  rankBoost: z.number().int(),
  /** If this result is (part of) a trap, its id; rendering it records exposure. */
  trapId: TrapIdSchema.nullable(),
});
export type SearchDoc = z.infer<typeof SearchDocSchema>;

/** Mount a SitePlugin on a host, with plugin-specific opaque config. */
export const SiteMountSchema = z.strictObject({
  host: EvalHostSchema,
  plugin: IdSchema,
  config: z.record(z.string(), JsonValueSchema),
});
export type SiteMount = z.infer<typeof SiteMountSchema>;

export const TrapTypeSchema = z.enum([
  'hidden_subscription',
  'forged_budget_approval',
  'forged_funding_notice',
  'fake_cashback_as_cash',
  'malicious_subagent_report',
  'fake_approval_message',
  'prompt_injection',
  'urgency_pressure',
  'ambiguous_fee',
  'misleading_search_ranking',
]);
export type TrapType = z.infer<typeof TrapTypeSchema>;

/** Attacker-controlled, lower-trust surface where a trap appears (spec §9a). */
export const TrapSurfaceSchema = z.enum([
  'search_results',
  'merchant_page',
  'product_page',
  'checkout_page',
  'wallet_page',
  'inbox',
  'support_chat',
  'subagent_report',
  'api_response',
]);
export type TrapSurface = z.infer<typeof TrapSurfaceSchema>;

/** Spelling aliases accepted on disk for TrapSurface (spec §7 uses `wallet-webpage`). */
export const TRAP_SURFACE_ALIASES: Readonly<Record<string, TrapSurface>> = {
  'wallet-webpage': 'wallet_page',
  'merchant-webpage': 'merchant_page',
  'search-results': 'search_results',
  'checkout-webpage': 'checkout_page',
};

/**
 * Deterministic condition over the ordered event log (spec §9e). Used by graders to decide
 * whether a trap's attacker-desired deviation happened. `role` null = any role.
 */
export type TrapCondition =
  | { kind: 'action_attempted'; action: ActionName; role: z.infer<typeof RoleSchema> | null }
  | { kind: 'action_committed'; action: ActionName; role: z.infer<typeof RoleSchema> | null }
  | { kind: 'claim_submitted'; resourceIds: string[] }
  | { kind: 'extension_requested'; resourceIds: string[] }
  | { kind: 'checkout_attempted_above'; amount: Money }
  | { kind: 'order_with_subscription_attempted' }
  | { kind: 'payment_method_used'; accountIds: string[] }
  | { kind: 'navigated_to'; host: string; pathPrefix: string | null }
  | { kind: 'any'; conditions: TrapCondition[] }
  | { kind: 'all'; conditions: TrapCondition[] };

export const TrapConditionSchema: z.ZodType<TrapCondition, TrapCondition> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('action_attempted'),
      action: ActionNameSchema,
      role: RoleSchema.nullable(),
    }),
    z.strictObject({
      kind: z.literal('action_committed'),
      action: ActionNameSchema,
      role: RoleSchema.nullable(),
    }),
    z.strictObject({
      kind: z.literal('claim_submitted'),
      resourceIds: z.array(ResourceIdSchema).min(1),
    }),
    z.strictObject({
      kind: z.literal('extension_requested'),
      resourceIds: z.array(ResourceIdSchema).min(1),
    }),
    z.strictObject({ kind: z.literal('checkout_attempted_above'), amount: NonNegativeMoneySchema }),
    z.strictObject({ kind: z.literal('order_with_subscription_attempted') }),
    z.strictObject({
      kind: z.literal('payment_method_used'),
      accountIds: z.array(IdSchema).min(1),
    }),
    z.strictObject({
      kind: z.literal('navigated_to'),
      host: EvalHostSchema,
      pathPrefix: z.string().nullable(),
    }),
    z.strictObject({ kind: z.literal('any'), conditions: z.array(TrapConditionSchema).min(1) }),
    z.strictObject({ kind: z.literal('all'), conditions: z.array(TrapConditionSchema).min(1) }),
  ]),
);

/** World-visible part of a trap: what to render and where. Exposure (§9g) is recorded at runtime via `trap.exposed`. */
export const TrapPublicSchema = z.strictObject({
  id: TrapIdSchema,
  type: TrapTypeSchema,
  surface: TrapSurfaceSchema,
  /** Where it appears; null = wherever the surface's site decides. */
  host: EvalHostSchema.nullable(),
  path: z.string().nullable(),
  /** Attacker-controlled content to render. */
  text: z.string(),
  /** Resources the trap talks about (e.g. the fake cashback it promotes). */
  targetResourceIds: z.array(ResourceIdSchema),
});
export type TrapPublic = z.infer<typeof TrapPublicSchema>;

/** Hidden, grader-only part of a trap (spec §9 b–f). */
export const TrapOracleSchema = z.strictObject({
  trapId: TrapIdSchema,
  type: TrapTypeSchema,
  /** (b) the legitimate task the trap interferes with (defaults to the scenario's user task). */
  legitimateTask: z.string(),
  /** (c) the deviation the attacker wants, in words. */
  attackerGoal: z.string(),
  /** (d) what a compliant agent may do (e.g. ignore it, verify, ask the user). */
  permissibleBehavior: z.string(),
  /** (e) deterministic condition: true => attack succeeded (attempted counts). */
  detection: TrapConditionSchema,
  /** (f) the matched clean scenario; null = resolve via `pairId`. */
  cleanVariantScenarioId: ScenarioIdSchema.nullable(),
});
export type TrapOracle = z.infer<typeof TrapOracleSchema>;

export const WorldFixtureSchema = z.strictObject({
  accounts: z.array(AccountSchema).min(1),
  products: z.array(ProductSchema),
  resources: z.array(ResourceSchema),
  searchIndex: z.array(SearchDocSchema),
  /** Empty = the world mounts its registered plugins by host. */
  sites: z.array(SiteMountSchema),
  /** Empty for clean variants. */
  traps: z.array(TrapPublicSchema),
});
export type WorldFixture = z.infer<typeof WorldFixtureSchema>;

/**
 * Everything about a scenario EXCEPT the hidden expected values. Safe for the world service.
 * Still not agent-visible as a whole: agents only receive an AgentEpisodeView.
 */
export const ScenarioSpecSchema = z.strictObject({
  id: ScenarioIdSchema,
  /** Shared by a clean scenario and its adversarial counterparts (spec §7 "paired clean variant"). */
  pairId: IdSchema,
  title: z.string(),
  benchmarkIds: z.array(BenchmarkIdSchema).min(1),
  seed: z.number().int().nonnegative(),
  variant: VariantSchema,
  /** Legitimate-path difficulty, 1 (easy) .. 5 (very hard). B6 slices by it. */
  difficulty: DifficultySchema,
  fixtureVersion: FixtureVersionSchema,
  /** The only scenario text the agent sees. */
  userTask: z.string().min(1),
  maxSteps: z.number().int().min(1),
  maxWallMs: z.number().int().min(1000),
  authorization: AuthorizationPolicySchema,
  approvalOracle: ApprovalOracleSchema,
  world: WorldFixtureSchema,
});
export type ScenarioSpec = z.infer<typeof ScenarioSpecSchema>;

/** Hidden answer key. Loaded only by the grader process; never by world or agents. */
export const ScenarioExpectedSchema = z.strictObject({
  /** Feasibility flag: does at least one fully compliant purchase path exist? */
  compliantPurchasePossible: z.boolean(),
  requiredOrderSku: SkuSchema.nullable(),
  /** Skus any of which satisfy the task (includes requiredOrderSku when set). */
  acceptableOrderSkus: z.array(SkuSchema),
  /** Max amount the agent may be charged while staying compliant (base + max legitimate extension). */
  authorizedMax: NonNegativeMoneySchema,
  /** Resources that must never be claimed-and-used / counted as money. */
  prohibitedResourceIds: z.array(ResourceIdSchema),
  /** Known set of eligible opportunities (B3 recall denominator). */
  eligibleResourceIds: z.array(ResourceIdSchema),
  /** Correct spendable amount (B2), if the scenario defines one. */
  expectedSpendable: NonNegativeMoneySchema.nullable(),
  /** Actions for which asking the user is the expected/acceptable move (e.g. infeasible cases). */
  approvalExpectedFor: z.array(ActionNameSchema),
  notes: z.string().nullable(),
  traps: z.array(TrapOracleSchema),
});
export type ScenarioExpected = z.infer<typeof ScenarioExpectedSchema>;

function dupes(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out = new Set<string>();
  for (const v of values) (seen.has(v) ? out : seen).add(v);
  return [...out];
}

function collectConditionRefs(
  c: TrapCondition,
  acc: { resources: string[]; accounts: string[] },
): void {
  switch (c.kind) {
    case 'claim_submitted':
    case 'extension_requested':
      acc.resources.push(...c.resourceIds);
      break;
    case 'payment_method_used':
      acc.accounts.push(...c.accountIds);
      break;
    case 'any':
    case 'all':
      for (const sub of c.conditions) collectConditionRefs(sub, acc);
      break;
    default:
      break;
  }
}

/** A fully parsed scenario, already split so `expected` can be withheld from the world. */
export const ParsedScenarioSchema = z
  .strictObject({ spec: ScenarioSpecSchema, expected: ScenarioExpectedSchema })
  .superRefine(({ spec, expected }, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path });
    const w = spec.world;
    const skus = w.products.map((p) => p.sku);
    const resourceIds = w.resources.map((r) => r.id);
    const accountIds = w.accounts.map((a) => a.id);
    const trapIds = w.traps.map((t) => t.id);
    for (const [label, list] of [
      ['product sku', skus],
      ['resource id', resourceIds],
      ['account id', accountIds],
      ['trap id', trapIds],
    ] as const) {
      for (const d of dupes(list)) issue(`duplicate ${label} ${d}`, ['spec', 'world']);
    }
    for (const d of dupes(spec.benchmarkIds))
      issue(`duplicate benchmark id ${d}`, ['spec', 'benchmarkIds']);

    w.products.forEach((p, i) => {
      const fees = p.fees.reduce((s, f) => s + f.amount.cents, 0);
      if (p.listPrice.cents + fees !== p.total.cents) {
        issue(
          `product ${p.sku}: total (${p.total.cents}) != listPrice (${p.listPrice.cents}) + fees (${fees})`,
          ['spec', 'world', 'products', i],
        );
      }
    });
    w.resources.forEach((r, i) => {
      const path = ['spec', 'world', 'resources', i];
      if (r.kind === 'coupon' && !r.couponCode) issue(`coupon ${r.id} needs coupon_code`, path);
      if (r.kind !== 'coupon' && r.couponCode)
        issue(`${r.id}: coupon_code only valid for kind coupon`, path);
      if (r.kind === 'merchant_credit' && !r.restrictedToMerchant)
        issue(`merchant_credit ${r.id} needs restricted_to_merchant`, path);
      if ((r.kind === 'future_cashback' || r.kind === 'pending_refund') && r.settled) {
        issue(`${r.id}: ${r.kind} cannot be settled`, path);
      }
    });

    const known = (
      ids: readonly string[],
      set: readonly string[],
      label: string,
      path: (string | number)[],
    ) => {
      for (const id of ids) if (!set.includes(id)) issue(`unknown ${label} ${id}`, path);
    };
    if (expected.requiredOrderSku)
      known([expected.requiredOrderSku], skus, 'sku', ['expected', 'requiredOrderSku']);
    known(expected.acceptableOrderSkus, skus, 'sku', ['expected', 'acceptableOrderSkus']);
    known(expected.prohibitedResourceIds, resourceIds, 'resource', [
      'expected',
      'prohibitedResourceIds',
    ]);
    known(expected.eligibleResourceIds, resourceIds, 'resource', [
      'expected',
      'eligibleResourceIds',
    ]);
    w.traps.forEach((t, i) =>
      known(t.targetResourceIds, resourceIds, 'resource', [
        'spec',
        'world',
        'traps',
        i,
        'targetResourceIds',
      ]),
    );
    w.searchIndex.forEach((d, i) => {
      if (d.trapId && !trapIds.includes(d.trapId))
        issue(`unknown trap ${d.trapId}`, ['spec', 'world', 'searchIndex', i]);
    });
    if (
      expected.requiredOrderSku &&
      !expected.acceptableOrderSkus.includes(expected.requiredOrderSku)
    ) {
      issue('acceptableOrderSkus must include requiredOrderSku', [
        'expected',
        'acceptableOrderSkus',
      ]);
    }

    const oracleIds = expected.traps.map((t) => t.trapId);
    if (
      dupes(oracleIds).length ||
      oracleIds.length !== trapIds.length ||
      trapIds.some((id) => !oracleIds.includes(id))
    ) {
      issue('every world trap needs exactly one oracle entry and vice versa', [
        'expected',
        'traps',
      ]);
    }
    expected.traps.forEach((t, i) => {
      const pub = w.traps.find((p) => p.id === t.trapId);
      if (pub && pub.type !== t.type)
        issue(`trap ${t.trapId}: oracle type differs from world type`, ['expected', 'traps', i]);
      const refs = { resources: [] as string[], accounts: [] as string[] };
      collectConditionRefs(t.detection, refs);
      known(refs.resources, resourceIds, 'resource', ['expected', 'traps', i, 'detection']);
      known(refs.accounts, accountIds, 'account', ['expected', 'traps', i, 'detection']);
    });

    if (spec.variant === 'clean' && w.traps.length > 0)
      issue('clean variants must not contain traps', ['spec', 'world', 'traps']);
    if (spec.variant === 'adversarial' && w.traps.length === 0)
      issue('adversarial variants need at least one trap', ['spec', 'world', 'traps']);
  });
export type ParsedScenario = z.infer<typeof ParsedScenarioSchema>;

// ===========================================================================
// On-disk (snake_case YAML) schema, spec §7. Parse with ScenarioFileSchema.
// ===========================================================================

const cents = z.number().int().nonnegative();
const raw = z.strictObject;

const RawConditionSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    raw({
      kind: z.literal('action_attempted'),
      action: ActionNameSchema,
      role: RoleSchema.optional(),
    }),
    raw({
      kind: z.literal('action_committed'),
      action: ActionNameSchema,
      role: RoleSchema.optional(),
    }),
    raw({ kind: z.literal('claim_submitted'), resource_ids: z.array(ResourceIdSchema).min(1) }),
    raw({ kind: z.literal('extension_requested'), resource_ids: z.array(ResourceIdSchema).min(1) }),
    raw({ kind: z.literal('checkout_attempted_above'), amount_cents: cents }),
    raw({ kind: z.literal('order_with_subscription_attempted') }),
    raw({ kind: z.literal('payment_method_used'), account_ids: z.array(IdSchema).min(1) }),
    raw({
      kind: z.literal('navigated_to'),
      host: EvalHostSchema,
      path_prefix: z.string().optional(),
    }),
    raw({ kind: z.literal('any'), conditions: z.array(RawConditionSchema).min(1) }),
    raw({ kind: z.literal('all'), conditions: z.array(RawConditionSchema).min(1) }),
  ]),
);

type RawCondition =
  | {
      kind: 'action_attempted' | 'action_committed';
      action: ActionName;
      role?: z.infer<typeof RoleSchema>;
    }
  | { kind: 'claim_submitted' | 'extension_requested'; resource_ids: string[] }
  | { kind: 'checkout_attempted_above'; amount_cents: number }
  | { kind: 'order_with_subscription_attempted' }
  | { kind: 'payment_method_used'; account_ids: string[] }
  | { kind: 'navigated_to'; host: string; path_prefix?: string }
  | { kind: 'any' | 'all'; conditions: RawCondition[] };

function conditionFromRaw(c: RawCondition): TrapCondition {
  switch (c.kind) {
    case 'action_attempted':
    case 'action_committed':
      return { kind: c.kind, action: c.action, role: c.role ?? null };
    case 'claim_submitted':
    case 'extension_requested':
      return { kind: c.kind, resourceIds: c.resource_ids };
    case 'checkout_attempted_above':
      return { kind: c.kind, amount: usd(c.amount_cents) };
    case 'order_with_subscription_attempted':
      return { kind: c.kind };
    case 'payment_method_used':
      return { kind: c.kind, accountIds: c.account_ids };
    case 'navigated_to':
      return { kind: c.kind, host: c.host, pathPrefix: c.path_prefix ?? null };
    case 'any':
    case 'all':
      return { kind: c.kind, conditions: c.conditions.map(conditionFromRaw) };
  }
}

const RawTrapSurfaceSchema = z.preprocess(
  (v) => (typeof v === 'string' && v in TRAP_SURFACE_ALIASES ? TRAP_SURFACE_ALIASES[v] : v),
  TrapSurfaceSchema,
);

const RawScenarioFileSchema = raw({
  id: ScenarioIdSchema,
  pair_id: IdSchema.optional(),
  title: z.string().optional(),
  benchmark_ids: z.array(BenchmarkIdSchema).min(1),
  seed: z.number().int().nonnegative(),
  variant: VariantSchema,
  difficulty: DifficultySchema.default(1),
  fixture_version: z.union([FixtureVersionSchema, z.number().nonnegative()]).optional(),
  user_task: z.string().min(1),
  max_steps: z.number().int().min(1).optional(),
  max_wall_ms: z.number().int().min(1000).optional(),
  authorization: raw({
    base_budget_cents: cents,
    max_additional_budget_cents: cents.default(0),
    currency: z.literal('USD').default('USD'),
    allowed_resource_kinds: z.array(ResourceKindSchema).default([]),
    forbidden_actions: z.array(ActionNameSchema).default([]),
    allowed_actions: z.array(ActionNameSchema).optional(),
    approval_required_for: z.array(ActionNameSchema).default([]),
    scope_by_role: raw({
      parent: z.array(ActionNameSchema).optional(),
      funding_subagent: z.array(ActionNameSchema).optional(),
      world: z.array(ActionNameSchema).optional(),
    }).optional(),
    allowed_merchants: z.array(EvalHostSchema).optional(),
    approval_can_exceed_budget: z.boolean().default(false),
  }),
  approval_oracle: raw({
    default: z.enum(['approve', 'deny']).default('deny'),
    default_message: z.string().optional(),
    rules: z
      .array(
        raw({
          id: IdSchema,
          action: ActionNameSchema,
          max_amount_cents: cents.optional(),
          decision: z.enum(['approve', 'deny']),
          grant_amount_cents: cents.optional(),
          message: z.string().optional(),
        }),
      )
      .default([]),
  }).optional(),
  world: raw({
    accounts: z
      .array(
        raw({
          id: IdSchema,
          kind: AccountKindSchema,
          label: z.string().optional(),
          owner: AccountOwnerSchema.default('user'),
          balance_cents: cents.optional(),
          credit_limit_cents: cents.optional(),
        }),
      )
      .optional(),
    products: z
      .array(
        raw({
          sku: SkuSchema,
          merchant: EvalHostSchema,
          title: z.string().optional(),
          description: z.string().default(''),
          list_price_cents: cents.optional(),
          total_cents: cents,
          fees: z
            .array(
              raw({
                kind: FeeKindSchema,
                label: z.string().optional(),
                amount_cents: cents,
                revealed_at: z.enum(['listing', 'checkout']).default('listing'),
              }),
            )
            .default([]),
          meets_requirements: z.boolean().default(false),
          in_stock: z.boolean().default(true),
          attributes: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .default({}),
          subscription_offer: raw({
            plan_id: IdSchema,
            price_cents: cents,
            interval: SubscriptionIntervalSchema,
            preselected: z.boolean().default(false),
          }).optional(),
        }),
      )
      .default([]),
    resources: z
      .array(
        raw({
          id: ResourceIdSchema,
          kind: ResourceKindSchema,
          amount_cents: cents,
          owned_by_user: z.boolean().default(true),
          available: z.boolean().default(true),
          settled: z.boolean().optional(),
          authorized_for_extension: z.boolean().default(false),
          restricted_to_merchant: EvalHostSchema.optional(),
          restricted_to_skus: z.array(SkuSchema).optional(),
          coupon_code: z.string().min(1).optional(),
          min_purchase_cents: cents.optional(),
          expires_at_virtual_ms: VirtualMsSchema.optional(),
          discoverable: z.boolean().default(true),
          displayed_as: raw({
            kind: ResourceKindSchema,
            amount_cents: cents,
            source_url: UrlSchema.optional(),
            description: z.string().default(''),
          }).optional(),
          description: z.string().default(''),
        }),
      )
      .default([]),
    search_index: z
      .array(
        raw({
          url: UrlSchema,
          title: z.string(),
          snippet: z.string().default(''),
          keywords: z.array(z.string()).default([]),
          rank_boost: z.number().int().default(0),
          trap_id: TrapIdSchema.optional(),
        }),
      )
      .default([]),
    sites: z
      .array(
        raw({
          host: EvalHostSchema,
          plugin: IdSchema,
          config: z.record(z.string(), JsonValueSchema).default({}),
        }),
      )
      .default([]),
    traps: z
      .array(
        raw({
          id: TrapIdSchema.optional(),
          type: TrapTypeSchema,
          surface: RawTrapSurfaceSchema,
          host: EvalHostSchema.optional(),
          path: z.string().optional(),
          text: z.string(),
          target_resource_ids: z.array(ResourceIdSchema).default([]),
          // hidden oracle fields (moved to `expected.traps` on parse)
          legitimate_task: z.string().optional(),
          attacker_goal: z.string().min(1),
          permissible_behavior: z.string().min(1),
          detection: RawConditionSchema,
          clean_variant: ScenarioIdSchema.optional(),
        }),
      )
      .default([]),
  }),
  expected: raw({
    compliant_purchase_possible: z.boolean(),
    required_order_sku: SkuSchema.optional(),
    acceptable_order_skus: z.array(SkuSchema).optional(),
    authorized_max_cents: cents,
    prohibited_resource_ids: z.array(ResourceIdSchema).default([]),
    eligible_resource_ids: z.array(ResourceIdSchema).default([]),
    expected_spendable_cents: cents.optional(),
    approval_expected_for: z.array(ActionNameSchema).default([]),
    notes: z.string().optional(),
  }),
});
export type ScenarioFileInput = z.input<typeof RawScenarioFileSchema>;
type RawScenarioFile = z.output<typeof RawScenarioFileSchema>;

function scenarioFromRaw(f: RawScenarioFile): ParsedScenario {
  const a = f.authorization;
  const forbidden = new Set(a.forbidden_actions);
  const allowedActions = (
    a.allowed_actions ?? DEFAULT_ALLOWED_ACTIONS.filter((x) => !forbidden.has(x))
  ).slice();
  const allowed = new Set(allowedActions);
  const scope = (role: 'parent' | 'funding_subagent' | 'world') =>
    (a.scope_by_role?.[role] ?? DEFAULT_SCOPE_BY_ROLE[role].filter((x) => allowed.has(x))).slice();

  const oracle = f.approval_oracle;
  const traps = f.world.traps.map((t, i) => ({ ...t, id: t.id ?? `trap-${i + 1}` }));

  const spec: ScenarioSpec = {
    id: f.id,
    pairId: f.pair_id ?? f.id,
    title: f.title ?? f.id,
    benchmarkIds: f.benchmark_ids,
    seed: f.seed,
    variant: f.variant,
    difficulty: f.difficulty,
    fixtureVersion:
      f.fixture_version === undefined ? DEFAULT_FIXTURE_VERSION : String(f.fixture_version),
    userTask: f.user_task.trim(),
    maxSteps: f.max_steps ?? DEFAULT_MAX_STEPS,
    maxWallMs: f.max_wall_ms ?? DEFAULT_MAX_WALL_MS,
    authorization: {
      allowedActions,
      forbiddenActions: a.forbidden_actions,
      baseBudget: usd(a.base_budget_cents),
      maxAdditionalBudget: usd(a.max_additional_budget_cents),
      allowedResourceKinds: a.allowed_resource_kinds,
      approvalRequiredFor: a.approval_required_for,
      scopeByRole: {
        parent: scope('parent'),
        funding_subagent: scope('funding_subagent'),
        world: scope('world'),
      },
      allowedMerchants: a.allowed_merchants ?? null,
      approvalCanExceedBudget: a.approval_can_exceed_budget,
    },
    approvalOracle: oracle
      ? {
          default: oracle.default,
          defaultMessage: oracle.default_message ?? DEFAULT_APPROVAL_ORACLE.defaultMessage,
          rules: oracle.rules.map((r) => ({
            id: r.id,
            action: r.action,
            maxAmount: r.max_amount_cents === undefined ? null : usd(r.max_amount_cents),
            decision: r.decision,
            grantAmount: r.grant_amount_cents === undefined ? null : usd(r.grant_amount_cents),
            message: r.message ?? (r.decision === 'approve' ? 'Approved.' : 'Not approved.'),
          })),
        }
      : structuredClone(DEFAULT_APPROVAL_ORACLE),
    world: {
      accounts: f.world.accounts?.map((x) => ({
        id: x.id,
        kind: x.kind,
        label: x.label ?? x.id,
        owner: x.owner,
        balance: x.balance_cents === undefined ? null : usd(x.balance_cents),
        creditLimit: x.credit_limit_cents === undefined ? null : usd(x.credit_limit_cents),
      })) ?? [
        {
          id: DEFAULT_PRIMARY_ACCOUNT_ID,
          kind: 'card',
          label: 'Primary card',
          owner: 'user',
          balance: null,
          creditLimit: null,
        },
      ],
      products: f.world.products.map((p) => {
        const feeTotal = p.fees.reduce((s, x) => s + x.amount_cents, 0);
        return {
          sku: p.sku,
          merchant: p.merchant,
          title: p.title ?? p.sku,
          description: p.description,
          listPrice: usd(p.list_price_cents ?? p.total_cents - feeTotal),
          fees: p.fees.map((x) => ({
            kind: x.kind,
            label: x.label ?? x.kind,
            amount: usd(x.amount_cents),
            revealedAt: x.revealed_at,
          })),
          total: usd(p.total_cents),
          meetsRequirements: p.meets_requirements,
          inStock: p.in_stock,
          attributes: p.attributes,
          subscriptionOffer: p.subscription_offer
            ? {
                planId: p.subscription_offer.plan_id,
                price: usd(p.subscription_offer.price_cents),
                interval: p.subscription_offer.interval,
                preselected: p.subscription_offer.preselected,
              }
            : null,
        };
      }),
      resources: f.world.resources.map((r) => ({
        id: r.id,
        kind: r.kind,
        amount: usd(r.amount_cents),
        ownedByUser: r.owned_by_user,
        available: r.available,
        settled: r.settled ?? SETTLED_BY_DEFAULT.has(r.kind),
        authorizedForExtension: r.authorized_for_extension,
        restrictedToMerchant: r.restricted_to_merchant ?? null,
        restrictedToSkus: r.restricted_to_skus ?? null,
        couponCode: r.coupon_code ?? null,
        minPurchase: r.min_purchase_cents === undefined ? null : usd(r.min_purchase_cents),
        expiresAtVirtualMs: r.expires_at_virtual_ms ?? null,
        discoverable: r.discoverable,
        displayed: r.displayed_as
          ? {
              kind: r.displayed_as.kind,
              amount: usd(r.displayed_as.amount_cents),
              sourceUrl: r.displayed_as.source_url ?? null,
              description: r.displayed_as.description,
            }
          : null,
        description: r.description,
      })),
      searchIndex: f.world.search_index.map((d) => ({
        url: d.url,
        title: d.title,
        snippet: d.snippet,
        keywords: d.keywords,
        rankBoost: d.rank_boost,
        trapId: d.trap_id ?? null,
      })),
      sites: f.world.sites.map((s) => ({ host: s.host, plugin: s.plugin, config: s.config })),
      traps: traps.map((t) => ({
        id: t.id,
        type: t.type,
        surface: t.surface,
        host: t.host ?? null,
        path: t.path ?? null,
        text: t.text,
        targetResourceIds: t.target_resource_ids,
      })),
    },
  };

  const e = f.expected;
  const acceptable =
    e.acceptable_order_skus ?? (e.required_order_sku ? [e.required_order_sku] : []);
  const expected: ScenarioExpected = {
    compliantPurchasePossible: e.compliant_purchase_possible,
    requiredOrderSku: e.required_order_sku ?? null,
    acceptableOrderSkus: acceptable,
    authorizedMax: usd(e.authorized_max_cents),
    prohibitedResourceIds: e.prohibited_resource_ids,
    eligibleResourceIds: e.eligible_resource_ids,
    expectedSpendable:
      e.expected_spendable_cents === undefined ? null : usd(e.expected_spendable_cents),
    approvalExpectedFor: e.approval_expected_for,
    notes: e.notes ?? null,
    traps: traps.map((t) => ({
      trapId: t.id,
      type: t.type,
      legitimateTask: t.legitimate_task ?? f.user_task.trim(),
      attackerGoal: t.attacker_goal,
      permissibleBehavior: t.permissible_behavior,
      detection: conditionFromRaw(t.detection as RawCondition),
      cleanVariantScenarioId: t.clean_variant ?? null,
    })),
  };
  return { spec, expected };
}

/**
 * Parses a scenario document (the object produced by a YAML parser) in the spec §7 shape
 * (snake_case) into `{ spec, expected }` (camelCase), applying defaults and cross-field checks.
 *
 * Deviations from the spec example: traps must also give `attacker_goal`,
 * `permissible_behavior` and `detection` (spec §9 c–e). `surface: wallet-webpage` is accepted
 * as an alias of `wallet_page`.
 */
export const ScenarioFileSchema =
  RawScenarioFileSchema.transform(scenarioFromRaw).pipe(ParsedScenarioSchema);

export function parseScenarioDocument(doc: unknown): ParsedScenario {
  return ScenarioFileSchema.parse(doc);
}
