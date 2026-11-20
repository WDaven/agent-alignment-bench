import { z } from 'zod';

export const RoleSchema = z.enum(['parent', 'funding_subagent', 'world']);
export type Role = z.infer<typeof RoleSchema>;
export const ROLES = RoleSchema.options;

export const AgentRoleSchema = z.enum(['parent', 'funding_subagent']);
export type AgentRole = z.infer<typeof AgentRoleSchema>;
export const AGENT_ROLES = AgentRoleSchema.options;

export const BenchmarkIdSchema = z.enum(['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7']);
export type BenchmarkId = z.infer<typeof BenchmarkIdSchema>;
export const BENCHMARK_IDS = BenchmarkIdSchema.options;

export const BENCHMARK_TITLES: Readonly<Record<BenchmarkId, string>> = {
  B0: 'Task Completion',
  B1: 'Spending Boundaries',
  B2: 'Financial Reasoning',
  B3: 'Resource Acquisition',
  B4: 'Delegation Integrity',
  B5: 'Adversarial Web',
  B6: 'Goal Pressure',
  B7: 'End-to-End',
};

export const VariantSchema = z.enum(['clean', 'adversarial']);
export type Variant = z.infer<typeof VariantSchema>;

export const SeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

export const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'ids are [A-Za-z0-9._:-], starting alphanumeric');
export type Id = z.infer<typeof IdSchema>;

export const ScenarioIdSchema = IdSchema;
export const EpisodeIdSchema = IdSchema;
export const RunIdSchema = IdSchema;
export const EventIdSchema = IdSchema;
export const AttemptIdSchema = IdSchema;
export const OrderIdSchema = IdSchema;
export const ClaimIdSchema = IdSchema;
export const ResourceIdSchema = IdSchema;
export const ApprovalIdSchema = IdSchema;
export const DelegationIdSchema = IdSchema;
export const TrapIdSchema = IdSchema;
export const SkuSchema = IdSchema;

export const HostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
    'lower-case DNS host, no port',
  );
export type Host = z.infer<typeof HostSchema>;

export const EVAL_DOMAIN = 'eval.test';

export function isEvalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === EVAL_DOMAIN || h.endsWith(`.${EVAL_DOMAIN}`);
}

export const EvalHostSchema = HostSchema.refine(isEvalHost, 'host must be under eval.test');

export const PROBE_HOST = 'probe.eval.test';

export const UrlSchema = z.url({ protocol: /^https?$/ });

export const VirtualMsSchema = z.number().int().nonnegative();

export const IsoTimestampSchema = z.iso.datetime({ offset: true });

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue, JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);
