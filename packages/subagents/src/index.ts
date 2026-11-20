import type {
  AgentAdapter,
  AgentAdapterFactory,
  AgentEpisodeView,
  AgentObserver,
  AgentRunResult,
  AgentTools,
} from '@aab/protocol';

export interface DelegationStartedInfo {
  delegationId: string;
  parentRole: string;
  childRole: 'funding_subagent' | 'parent';
  task: string;
  grantedScope: readonly string[];
}

export type DelegationEndStatus = 'completed' | 'timeout' | 'error' | 'cancelled';

export interface DelegationHost {
  onDelegationStarted(cb: (d: DelegationStartedInfo) => void): () => void;
  childCredentials(delegationId: string): Promise<{ token: string; view: AgentEpisodeView }>;
  childSteps(delegationId: string): Promise<number>;
  hasReport(delegationId: string): Promise<boolean>;
  submitRunnerReport(delegationId: string, summary: string): Promise<void>;
  endDelegation(
    delegationId: string,
    status: DelegationEndStatus,
    finalResponse: string | null,
  ): Promise<void>;
  provision(
    delegationId: string,
    token: string,
    view: AgentEpisodeView,
  ): Promise<{ tools: AgentTools; release(): Promise<void> }>;
}

export interface ChildLimits {
  maxSteps?: number;
  maxWallMs?: number;
  pollMs?: number;
}

export interface ChildRecord {
  delegationId: string;
  status: DelegationEndStatus;
  result: AgentRunResult | null;
  error: string | null;
  stepsUsed: number;
}

export class DelegationManager {
  private readonly running = new Map<
    string,
    { adapter: AgentAdapter | null; done: Promise<ChildRecord> }
  >();
  private readonly finished: ChildRecord[] = [];
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly host: DelegationHost,
    private readonly factory: AgentAdapterFactory,
    private readonly limits: ChildLimits = {},
    private readonly observerFor?: (delegationId: string) => AgentObserver | undefined,
  ) {}

  start(): void {
    this.unsubscribe = this.host.onDelegationStarted((d) => {
      if (this.closed || this.running.has(d.delegationId)) return;
      const entry: { adapter: AgentAdapter | null; done: Promise<ChildRecord> } = {
        adapter: null,
        done: Promise.resolve(null as never),
      };
      entry.done = this.runChild(d, entry).then((rec) => {
        this.finished.push(rec);
        return rec;
      });
      this.running.set(d.delegationId, entry);
    });
  }

  get records(): readonly ChildRecord[] {
    return this.finished;
  }

  private async runChild(
    d: DelegationStartedInfo,
    entry: { adapter: AgentAdapter | null },
  ): Promise<ChildRecord> {
    let release: (() => Promise<void>) | null = null;
    let status: DelegationEndStatus = 'error';
    let result: AgentRunResult | null = null;
    let error: string | null = null;
    let steps = 0;
    try {
      const { token, view } = await this.host.childCredentials(d.delegationId);
      const env = await this.host.provision(d.delegationId, token, view);
      release = env.release;
      const adapter = this.factory({ role: 'funding_subagent', delegationId: d.delegationId });
      entry.adapter = adapter;
      const maxSteps = this.limits.maxSteps ?? view.maxSteps;
      const maxWallMs = this.limits.maxWallMs ?? view.maxWallMs;
      await adapter.start(view, env.tools, this.observerFor?.(d.delegationId));
      let limitHit: 'steps' | 'wall' | null = null;
      const poll = setInterval(() => {
        void this.host.childSteps(d.delegationId).then((n) => {
          steps = n;
          if (n > maxSteps && !limitHit) {
            limitHit = 'steps';
            void adapter.stop();
          }
        });
      }, this.limits.pollMs ?? 200);
      const wall = setTimeout(() => {
        limitHit ??= 'wall';
        void adapter.stop();
      }, maxWallMs);
      try {
        result = await adapter.runUntilDone();
      } finally {
        clearInterval(poll);
        clearTimeout(wall);
        await adapter.stop().catch(() => undefined);
      }
      steps = await this.host.childSteps(d.delegationId);
      if (limitHit || result.status === 'timeout') status = 'timeout';
      else status = result.status === 'done' ? 'completed' : 'error';
      error = limitHit
        ? `child exceeded its ${limitHit === 'steps' ? 'step' : 'wall-clock'} limit`
        : result.error;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      status = 'error';
    }
    const finalResponse = result?.finalResponse ?? null;
    try {
      if (finalResponse && !(await this.host.hasReport(d.delegationId)))
        await this.host.submitRunnerReport(d.delegationId, finalResponse);
    } catch {}
    try {
      await this.host.endDelegation(
        d.delegationId,
        this.closed ? 'cancelled' : status,
        finalResponse,
      );
    } catch {}
    await release?.().catch(() => undefined);
    return { delegationId: d.delegationId, status, result, error, stepsUsed: steps };
  }

  async drain(): Promise<readonly ChildRecord[]> {
    await Promise.all([...this.running.values()].map((r) => r.done));
    return this.finished;
  }

  async stopAll(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    await Promise.all(
      [...this.running.values()].map((r) => r.adapter?.stop().catch(() => undefined)),
    );
    await this.drain();
  }
}
