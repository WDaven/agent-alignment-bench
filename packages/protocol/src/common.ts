import { z } from 'zod';

/**
 * Who performed or caused something.
 * - `parent`: the agent under test that received the user task.
 * - `funding_subagent`: a delegated child agent with limited (discovery) scope.
 * - `world`: the simulation itself (system events, site plugins acting autonomously).
 */
export const RoleSchema = z.enum(['parent', 'funding_subagent', 'world']);
export type Role = z.infer<typeof RoleSchema>;
export const ROLES = RoleSchema.options;

/** Roles that are played by an agent (i.e. can hold a proxy listener, tools and a browser). */
export const AgentRoleSchema = z.enum(['parent', 'funding_subagent']);
export type AgentRole = z.infer<typeof AgentRoleSchema>;
export const AGENT_ROLES = AgentRoleSchema.options;

export const BenchmarkIdSchema = z.enum(['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7']);
export type BenchmarkId = z.infer<typeof BenchmarkIdSchema>;
export const BENCHMARK_IDS = BenchmarkIdSchema.options;

/** Human titles for each benchmark (spec §8). */
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

/** `clean` has no traps; `adversarial` is the same task with one or more traps added. */
export const VariantSchema = z.enum(['clean', 'adversarial']);
export type Variant = z.infer<typeof VariantSchema>;

export const SeveritySchema = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof SeveritySchema>;

/**
 * Generic identifier: non-empty, no whitespace, at most 128 chars. IDs are opaque; do not
 * parse them. World-generated IDs are deterministic for a given seed (e.g. `att-000017`).
 */
export const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'ids are [A-Za-z0-9._:-], starting alphanumeric');
export type Id = z.infer<typeof IdSchema>;

/** Scenario ids, e.g. `B4-unverified-funding-001`. */
export const ScenarioIdSchema = IdSchema;
export const EpisodeIdSchema = IdSchema;
export const RunIdSchema = IdSchema;
export const EventIdSchema = IdSchema;
/** Links an `action.attempted` event to its single outcome (`action.committed` or `action.denied`). */
export const AttemptIdSchema = IdSchema;
export const OrderIdSchema = IdSchema;
export const ClaimIdSchema = IdSchema;
export const ResourceIdSchema = IdSchema;
export const ApprovalIdSchema = IdSchema;
export const DelegationIdSchema = IdSchema;
export const TrapIdSchema = IdSchema;
export const SkuSchema = IdSchema;

/** Lower-case DNS host name without port, e.g. `shop-a.eval.test`. */
export const HostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/,
    'lower-case DNS host, no port',
  );
export type Host = z.infer<typeof HostSchema>;

/** The reserved TLD under which every simulated site lives. The eval CA is name-constrained to it. */
export const EVAL_DOMAIN = 'eval.test';

/** True for `eval.test` and any sub-domain of it. */
export function isEvalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === EVAL_DOMAIN || h.endsWith(`.${EVAL_DOMAIN}`);
}

/** Host schema restricted to `*.eval.test`. Simulated sites must use these. */
export const EvalHostSchema = HostSchema.refine(isEvalHost, 'host must be under eval.test');

/** Built-in diagnostic host used to test the interception path end to end (architecture.md). */
export const PROBE_HOST = 'probe.eval.test';

/** Absolute http(s) URL. */
export const UrlSchema = z.url({ protocol: /^https?$/ });

/**
 * Milliseconds on the world's deterministic virtual clock since episode start.
 * Never derived from browser or wall-clock timestamps.
 */
export const VirtualMsSchema = z.number().int().nonnegative();

/** ISO-8601 wall-clock timestamp. Only used in run metadata, never for ordering events. */
export const IsoTimestampSchema = z.iso.datetime({ offset: true });

/** JSON-compatible value (for opaque payloads such as raw tool arguments). */
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
