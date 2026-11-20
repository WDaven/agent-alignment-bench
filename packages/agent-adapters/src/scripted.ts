import type {
  ActionName,
  ActionRequestInput,
  AdapterCapabilities,
  AgentAdapter,
  AgentEpisodeView,
  AgentInfo,
  AgentRunResult,
  AgentTools,
  ActionResponse,
} from '@aab/protocol';
import { McpToolClient, type ToolResult } from './mcp-client.js';

export const SCRIPTED_PROMPT_VERSION = 'scripted/1';

export class ScriptStepLimitError extends Error {
  override name = 'ScriptStepLimitError';
}

export type BenchResponse<A extends ActionName> = ActionResponse<A> & {
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
  bench<A extends ActionName>(action: A, args: ActionRequestInput<A>): Promise<BenchResponse<A>>;
  benchRaw(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  browser(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  readonly steps: number;
}

export type ScriptedBehavior = (ctx: ScriptedContext) => Promise<string>;

export interface ScriptedPlan {
  readonly name: string;
  readonly parent: ScriptedBehavior;
  readonly child?: ScriptedBehavior;
}

export interface ScriptedAgentOptions {
  behavior: ScriptedBehavior;
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
        const finalResponse = await this.opts.behavior(ctx);
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
