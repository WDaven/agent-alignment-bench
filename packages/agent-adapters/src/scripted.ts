/**
 * ScriptedReferenceAgent: a deterministic agent used by tests and to validate that a scenario has
 * a compliant path (spec §12, §14). It talks to the world ONLY through the harness MCP servers it
 * is given (the same stdio `bench` / `browser` servers an LLM CLI gets), so its calls take exactly
 * the path an LLM agent's calls take and are journaled identically.
 *
 * Its behaviour is a `ScriptedPolicy`: an async function over a small context. The runner chooses
 * the policy (it knows the scenario); the agent itself only ever sees its AgentEpisodeView.
 */
import type {
  ActionName,
  ActionRequestInput,
  AdapterCapabilities,
  AgentAdapter,
  AgentEpisodeView,
  AgentInfo,
  AgentRunResult,
  AgentTools,
  WorldOpResponse,
} from '@aab/protocol';
import { McpToolClient, type ToolResult } from './mcp-client.js';

export const SCRIPTED_PROMPT_VERSION = 'scripted/1';

export class ScriptStepLimitError extends Error {
  override name = 'ScriptStepLimitError';
}

/** Result of a bench call: the world response, plus `child` for `delegate`. */
export type BenchResponse<A extends ActionName> = WorldOpResponse<A> & {
  child?: {
    status: string;
    finalResponse: string | null;
    reports: {
      reportId: string;
      summary: string;
      claimIds: string[];
      reportedResources: unknown[];
    }[];
  };
};

export interface ScriptedContext {
  readonly view: AgentEpisodeView;
  /** Call a bench tool (= world operation). Denials are normal return values. */
  bench<A extends ActionName>(action: A, args: ActionRequestInput<A>): Promise<BenchResponse<A>>;
  /** Call any bench tool name, including names that do not exist (journaled as action.unknown). */
  benchRaw(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** Call a browser tool, e.g. `browser('browser_navigate', { url })`. */
  browser(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** Number of tool calls so far. */
  readonly steps: number;
}

/** Returns the agent's final response. */
export type ScriptedPolicy = (ctx: ScriptedContext) => Promise<string>;

/** Parent policy plus, for delegation, the policy every child of this parent runs. */
export interface ScriptedPlan {
  readonly name: string;
  readonly parent: ScriptedPolicy;
  readonly child?: ScriptedPolicy;
}

export interface ScriptedAgentOptions {
  policy: ScriptedPolicy;
  /** Distinguishes plans in run metadata (agentId stays `scripted`). */
  planName?: string;
}

export class ScriptedReferenceAgent implements AgentAdapter {
  readonly info: AgentInfo;
  readonly capabilities: AdapterCapabilities = {
    browser: 'harness',
    search: 'harness',
    otherTools: 'none',
    supportsDelegation: true,
  };
  private view: AgentEpisodeView | null = null;
  private clients = new Map<string, McpToolClient>();
  private steps = 0;
  private stopped = false;

  constructor(private readonly opts: ScriptedAgentOptions) {
    this.info = {
      agentId: 'scripted',
      kind: 'scripted',
      model: null,
      modelVersion: opts.planName ?? null,
      cliVersion: null,
      promptVersion: SCRIPTED_PROMPT_VERSION,
    };
  }

  async start(view: AgentEpisodeView, tools: AgentTools): Promise<void> {
    this.view = view;
    for (const spec of tools.mcpServers) {
      const c = new McpToolClient(spec);
      await c.connect();
      this.clients.set(spec.name, c);
    }
  }

  private client(name: 'bench' | 'browser'): McpToolClient {
    const c = this.clients.get(name);
    if (!c) throw new Error(`no ${name} MCP server was provided`);
    return c;
  }

  private count(): void {
    if (this.stopped) throw new ScriptStepLimitError('agent stopped');
    this.steps += 1;
    if (this.view && this.steps > this.view.maxSteps * 2)
      throw new ScriptStepLimitError(
        `scripted agent exceeded ${this.view.maxSteps * 2} tool calls`,
      );
  }

  async runUntilDone(): Promise<AgentRunResult> {
    const view = this.view;
    if (!view) throw new Error('start() first');
    const self = this;
    const ctx: ScriptedContext = {
      view,
      get steps() {
        return self.steps;
      },
      async bench(action, args) {
        self.count();
        const r = await self.client('bench').call(action, args as Record<string, unknown>);
        if (r.isError || r.json === null)
          throw new Error(`bench ${action} failed: ${r.text.slice(0, 300)}`);
        return r.json as never;
      },
      async benchRaw(name, args) {
        self.count();
        return self.client('bench').call(name, args);
      },
      async browser(tool, args = {}) {
        self.count();
        return self.client('browser').call(tool, args);
      },
    };
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<AgentRunResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            status: 'timeout',
            finalResponse: null,
            error: 'wall-clock limit',
            usage: null,
          }),
        view.maxWallMs,
      );
    });
    const work = (async (): Promise<AgentRunResult> => {
      try {
        const finalResponse = await this.opts.policy(ctx);
        return { status: 'done', finalResponse, error: null, usage: this.usage() };
      } catch (err) {
        return {
          status: 'error',
          finalResponse: null,
          error: err instanceof Error ? err.message : String(err),
          usage: this.usage(),
        };
      }
    })();
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private usage() {
    return {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      turns: null,
      costMicroUsd: null,
      toolCalls: this.steps,
      worldActions: this.steps,
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.clients.values()].map((c) => c.close()));
    this.clients.clear();
  }
}
