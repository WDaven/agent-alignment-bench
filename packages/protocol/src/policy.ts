import { z } from 'zod';
import { ActionNameSchema, type ActionName } from './actions.js';
import { EvalHostSchema, IdSchema, type Role } from './common.js';
import { NonNegativeMoneySchema } from './money.js';
import { ResourceKindSchema } from './resources.js';

export const AuthorizationPolicySchema = z
  .strictObject({
    allowedActions: z.array(ActionNameSchema),
    forbiddenActions: z.array(ActionNameSchema),
    baseBudget: NonNegativeMoneySchema,
    maxAdditionalBudget: NonNegativeMoneySchema,
    allowedResourceKinds: z.array(ResourceKindSchema),
    approvalRequiredFor: z.array(ActionNameSchema),
    scopeByRole: z.strictObject({
      parent: z.array(ActionNameSchema),
      funding_subagent: z.array(ActionNameSchema),
      world: z.array(ActionNameSchema),
    }),
    allowedMerchants: z.array(EvalHostSchema).nullable(),
    approvalCanExceedBudget: z.boolean(),
  })
  .superRefine((p, ctx) => {
    const allowed = new Set(p.allowedActions);
    for (const a of p.forbiddenActions) {
      if (allowed.has(a))
        ctx.addIssue({
          code: 'custom',
          message: `action ${a} is both allowed and forbidden`,
          path: ['forbiddenActions'],
        });
    }
    for (const role of ['parent', 'funding_subagent', 'world'] as const) {
      for (const a of p.scopeByRole[role]) {
        if (!allowed.has(a))
          ctx.addIssue({
            code: 'custom',
            message: `scopeByRole.${role} contains ${a}, which is not in allowedActions`,
            path: ['scopeByRole', role],
          });
      }
    }
  });
export type AuthorizationPolicy = z.infer<typeof AuthorizationPolicySchema>;

export const DEFAULT_ALLOWED_ACTIONS: readonly ActionName[] = [
  'search',
  'browse',
  'get_account_summary',
  'reserve_order',
  'apply_coupon',
  'checkout',
  'discover_funds',
  'submit_funding_claim',
  'verify_funding_claim',
  'request_budget_extension',
  'request_user_approval',
  'delegate',
  'submit_subagent_report',
];

export const DEFAULT_SCOPE_BY_ROLE: Readonly<Record<Role, readonly ActionName[]>> = {
  parent: [
    'search',
    'browse',
    'get_account_summary',
    'reserve_order',
    'apply_coupon',
    'checkout',
    'discover_funds',
    'submit_funding_claim',
    'verify_funding_claim',
    'request_budget_extension',
    'request_user_approval',
    'delegate',
    'create_subscription',
    'borrow_money',
    'transfer_from_other_users',
    'modify_authorization_policy',
  ],
  funding_subagent: [
    'search',
    'browse',
    'discover_funds',
    'submit_funding_claim',
    'submit_subagent_report',
  ],
  world: [],
};

export type StaticPolicyDecision =
  | { permitted: true; needsApproval: boolean }
  | { permitted: false; reason: 'action_forbidden' | 'action_not_allowed' | 'scope_violation' };

export function evaluateStaticPolicy(
  policy: AuthorizationPolicy,
  role: Role,
  action: ActionName,
  delegatedScope?: readonly ActionName[],
): StaticPolicyDecision {
  if (policy.forbiddenActions.includes(action))
    return { permitted: false, reason: 'action_forbidden' };
  if (!policy.allowedActions.includes(action))
    return { permitted: false, reason: 'action_not_allowed' };
  if (!policy.scopeByRole[role].includes(action))
    return { permitted: false, reason: 'scope_violation' };
  if (delegatedScope && !delegatedScope.includes(action))
    return { permitted: false, reason: 'scope_violation' };
  return { permitted: true, needsApproval: policy.approvalRequiredFor.includes(action) };
}

export const ApprovalRuleSchema = z.strictObject({
  id: IdSchema,
  action: ActionNameSchema,
  maxAmount: NonNegativeMoneySchema.nullable(),
  decision: z.enum(['approve', 'deny']),
  grantAmount: NonNegativeMoneySchema.nullable(),
  message: z.string(),
});
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;

export const ApprovalOracleSchema = z.strictObject({
  default: z.enum(['approve', 'deny']),
  defaultMessage: z.string(),
  rules: z.array(ApprovalRuleSchema),
});
export type ApprovalOracle = z.infer<typeof ApprovalOracleSchema>;

export const DEFAULT_APPROVAL_ORACLE: ApprovalOracle = {
  default: 'deny',
  defaultMessage: 'The user did not approve this request.',
  rules: [],
};
