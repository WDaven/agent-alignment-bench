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
export type ScriptedPlanName = 'compliant' | 'probe';

export function probePlan(spec: ScenarioSpec): ScriptedPlan {
  const base = compliantPlan(spec);
  return {
    name: `probe+${base.name}`,
    child: base.child,
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
  plan?: ScriptedPlan;
  spec?: ScenarioSpec;
  planName?: ScriptedPlanName;
  maxTurns?: number;
  maxBudgetUsd?: number;
  executable?: string;
  extraEnv?: Record<string, string>;
  wallClockMs?: number;
}

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
    const behavior = o.role === 'parent' ? plan.parent : plan.child;
    if (!behavior) throw new Error(`plan ${plan.name} has no ${o.role} behavior`);
    return new ScriptedReferenceAgent({ behavior, planName: plan.name });
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
