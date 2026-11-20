import { mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import type {
  AdapterCapabilities,
  AgentAdapter,
  AgentEpisodeView,
  AgentInfo,
  AgentObserver,
  AgentRunResult,
  AgentTools,
  ObservedToolCall,
  ToolCost,
} from '@aab/protocol';
import {
  CLI_PROMPT_VERSION,
  HARNESS_SYSTEM_NOTE,
  cliVersion,
  emit,
  emptyUsage,
  openTranscript,
  spawnCli,
  type CliAdapterOptions,
  type CliAuthMode,
  type SpawnedCli,
} from './common.js';

export interface StreamState {
  finalResponse: string | null;
  usage: ToolCost;
  toolUses: number;
  streamError: string | null;
  modelVersion: string | null;
}

export interface CliInvocation {
  argv: string[];
  env: Record<string, string>;
  secrets: string[];
}

export function composePrompt(view: AgentEpisodeView): string {
  return `${HARNESS_SYSTEM_NOTE}\n\nUser task:\n${view.task}`;
}

export abstract class CliAgentAdapter implements AgentAdapter {
  abstract readonly info: AgentInfo;
  readonly capabilities: AdapterCapabilities = {
    browser: 'harness',
    search: 'harness',
    otherTools: 'none',
    supportsDelegation: true,
  };
  protected view: AgentEpisodeView | null = null;
  protected tools: AgentTools | null = null;
  protected observer: AgentObserver | undefined;
  protected proc: SpawnedCli | null = null;
  protected transcript: WriteStream | null = null;
  protected state: StreamState = {
    finalResponse: null,
    usage: emptyUsage(),
    toolUses: 0,
    streamError: null,
    modelVersion: null,
  };
  protected readonly auth: CliAuthMode;

  protected constructor(
    protected readonly opts: CliAdapterOptions,
    protected readonly defaultExecutable: string,
  ) {
    this.auth = opts.auth ?? 'api_key';
  }

  get executable(): string {
    return this.opts.executable ?? this.defaultExecutable;
  }

  protected abstract invocation(view: AgentEpisodeView, tools: AgentTools): CliInvocation;
  protected abstract onLine(line: string): void;

  protected async detectVersion(): Promise<string | null> {
    return cliVersion(this.executable);
  }

  async start(view: AgentEpisodeView, tools: AgentTools, observer?: AgentObserver): Promise<void> {
    this.view = view;
    this.tools = tools;
    this.observer = observer;
    mkdirSync(tools.workDir, { recursive: true, mode: 0o700 });
    mkdirSync(tools.configHome, { recursive: true, mode: 0o700 });
    (this.info as { cliVersion: string | null }).cliVersion = await this.detectVersion();
  }

  describeInvocation(
    view: AgentEpisodeView,
    tools: AgentTools,
  ): { argv: string[]; envNames: string[] } {
    const inv = this.invocation(view, tools);
    return { argv: inv.argv, envNames: Object.keys(inv.env).sort() };
  }

  protected observe(call: ObservedToolCall): void {
    emit(this.observer, call);
  }

  protected countToolUse(): void {
    this.state.toolUses += 1;
    const max = this.opts.maxTurns ?? (this.view ? this.view.maxSteps * 3 : 200);
    if (this.state.toolUses > max) this.proc?.kill('max_turns');
  }

  async runUntilDone(): Promise<AgentRunResult> {
    const view = this.view;
    const tools = this.tools;
    if (!view || !tools) throw new Error('start() first');
    let inv: CliInvocation;
    try {
      inv = this.invocation(view, tools);
    } catch (err) {
      return {
        status: 'error',
        finalResponse: null,
        error: err instanceof Error ? err.message : String(err),
        usage: null,
      };
    }
    this.transcript = openTranscript(this.opts.transcriptPath);
    const stderrTail: string[] = [];
    this.proc = spawnCli(this.executable, inv.argv, {
      cwd: tools.workDir,
      env: inv.env,
      secrets: inv.secrets,
      transcript: this.transcript,
      onStdoutLine: (line) => {
        try {
          this.onLine(line);
        } catch {}
      },
      onStderrLine: (line) => {
        stderrTail.push(line);
        if (stderrTail.length > 20) stderrTail.shift();
        this.observer?.onLog?.(line);
      },
    });
    const wall = this.opts.wallClockMs ?? view.maxWallMs;
    const timer = setTimeout(() => this.proc?.kill('wall_clock'), wall);
    const exit = await this.proc.exited;
    clearTimeout(timer);
    await new Promise((r) => setTimeout(r, 50));
    this.transcript?.end();
    this.state.usage.toolCalls = this.state.toolUses;
    const killed = this.proc.killReason;
    if (killed === 'wall_clock' || killed === 'max_turns')
      return {
        status: 'timeout',
        finalResponse: this.state.finalResponse,
        error: killed,
        usage: this.state.usage,
      };
    if (killed === 'stopped')
      return {
        status: 'error',
        finalResponse: this.state.finalResponse,
        error: 'stopped',
        usage: this.state.usage,
      };
    if (exit.code === 0 && !this.state.streamError)
      return {
        status: 'done',
        finalResponse: this.state.finalResponse,
        error: null,
        usage: this.state.usage,
      };
    return {
      status: 'error',
      finalResponse: this.state.finalResponse,
      error:
        this.state.streamError ??
        `exit ${exit.code ?? exit.signal}: ${stderrTail.slice(-3).join(' | ').slice(0, 500)}`,
      usage: this.state.usage,
    };
  }

  async stop(): Promise<void> {
    this.proc?.kill('stopped');
    if (this.proc) await this.proc.exited;
  }

  protected writeConfigFile(tools: AgentTools, name: string, content: string): string {
    const file = path.join(tools.configHome, name);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, content, { mode: 0o600 });
    return file;
  }
}

export { CLI_PROMPT_VERSION };
