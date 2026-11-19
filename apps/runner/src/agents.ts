import {
  ClaudeCodeAdapter,
  CodexAdapter,
  ScriptedReferenceAgent,
  compliantPlan,
  type CliAuthMode,
  type ScriptedPlan,
} from '@aab/agent-adapters';
import type { PassthroughPresetName } from '@aab/mitm-proxy';
import type { AgentAdapter, AgentRole, ScenarioSpec } from '@aab/protocol';

export type AgentKindName = 'scripted' | 'claude-code' | 'codex';
/** Built-in scripted plans selectable from the CLI (`--plan`). */
export type ScriptedPlanName = 'compliant' | 'probe';

/**
 * `probe`: open https://probe.eval.test and https://example.com in the harness browser (a smoke
 * check of the interception path, in local or container mode), then the compliant oracle.
 */
export function probePlan(spec: ScenarioSpec): ScriptedPlan {
  const base = compliantPlan(spec);
  return {
    name: `probe+${base.name}`,
    child: base.child!,
    parent: async (ctx) => {
      const probe = await ctx.browser('browser_navigate', { url: 'https://probe.eval.test/' });
      const ex = await ctx.browser('browser_navigate', { url: 'https://example.com/' });
      const rest = await base.parent(ctx);
      const role = /Role\s+(\S+)/.exec(probe.text)?.[1] ?? '?';
      return `probe role: ${role}; example.com: ${ex.isError ? 'blocked' : 'LOADED'}; ${rest}`;
    },
  };
}

export interface AgentSpec {
  kind: AgentKindName;
  model?: string | null;
  auth?: CliAuthMode;
  /** Scripted agents: the plan (default: the generic compliant oracle for the scenario). */
  plan?: ScriptedPlan;
  /** Scenario (scripted default plan). */
  spec?: ScenarioSpec;
  /** Built-in plan by name (default `compliant`). */
  planName?: ScriptedPlanName;
  maxTurns?: number;
  maxBudgetUsd?: number;
  /** Override the CLI executable (tests use a fake CLI). */
  executable?: string;
  /** Extra env for the CLI child (diagnostics). */
  extraEnv?: Record<string, string>;
  /** Wall-clock cap for the CLI (default: the episode's maxWallMs). */
  wallClockMs?: number;
}

/** Model-API passthrough presets for the CLI listener (the browser listener never gets any). */
export function presetsFor(agent: AgentSpec): PassthroughPresetName[] {
  if (agent.kind === 'claude-code') return ['anthropic'];
  if (agent.kind === 'codex') return ['openai'];
  return [];
}

export function createAdapter(
  agent: AgentSpec,
  o: { role: AgentRole; transcriptPath: string | null },
): AgentAdapter {
  if (agent.kind === 'scripted') {
    const plan =
      agent.plan ??
      (agent.spec
        ? agent.planName === 'probe'
          ? probePlan(agent.spec)
          : compliantPlan(agent.spec)
        : null);
    if (!plan) throw new Error('scripted agent needs a plan or a scenario');
    const policy = o.role === 'parent' ? plan.parent : plan.child;
    if (!policy) throw new Error(`plan ${plan.name} has no ${o.role} policy`);
    return new ScriptedReferenceAgent({ policy, planName: plan.name });
  }
  const common = {
    model: agent.model ?? null,
    auth: agent.auth ?? 'api_key',
    transcriptPath: o.transcriptPath,
    ...(agent.maxTurns ? { maxTurns: agent.maxTurns } : {}),
    ...(agent.maxBudgetUsd ? { maxBudgetUsd: agent.maxBudgetUsd } : {}),
    ...(agent.executable ? { executable: agent.executable } : {}),
    ...(agent.extraEnv ? { extraEnv: agent.extraEnv } : {}),
    ...(agent.wallClockMs ? { wallClockMs: agent.wallClockMs } : {}),
  };
  return agent.kind === 'claude-code' ? new ClaudeCodeAdapter(common) : new CodexAdapter(common);
}
