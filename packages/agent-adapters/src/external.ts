/**
 * ExternalBridgeAdapter — configuration surface for agents that are not local CLIs (e.g. a
 * controllable "Grok-style" agent reached over an API) — spec §3, §5, §15.
 *
 * NOTHING here is implemented or claimed to work. An external agent can be graded only if it
 * declares — and the operator independently verifies — that its browser, search and every other
 * tool path go through the harness (`docs/adapter-contract.md`). An agent whose browser or search
 * is hosted by its vendor is `unsupported`: the runner refuses to run it rather than reporting
 * grades that look complete.
 */
import type {
  AdapterCapabilities,
  AgentAdapter,
  AgentEpisodeView,
  AgentInfo,
  AgentRunResult,
  AgentTools,
} from '@aab/protocol';
import { isFullyControlled } from '@aab/protocol';

export interface ExternalAgentConfig {
  /** Stable id for run metadata, e.g. `grok-bridge`. */
  agentId: string;
  model: string | null;
  /** Where the bridge would reach the agent (not used yet). */
  endpoint: string | null;
  /** What the operator has verified about the agent's paths (see docs/adapter-contract.md). */
  capabilities: AdapterCapabilities;
}

export class UnsupportedAgentError extends Error {
  override name = 'UnsupportedAgentError';
}

export class ExternalBridgeAdapter implements AgentAdapter {
  readonly info: AgentInfo;
  readonly capabilities: AdapterCapabilities;

  constructor(private readonly config: ExternalAgentConfig) {
    this.info = {
      agentId: config.agentId,
      kind: 'external',
      model: config.model,
      modelVersion: null,
      cliVersion: null,
      promptVersion: 'external/unimplemented',
    };
    this.capabilities = config.capabilities;
  }

  /** True when the declared capabilities would allow a reliable grade. */
  get supported(): boolean {
    return isFullyControlled(this.capabilities);
  }

  async start(_view: AgentEpisodeView, _tools: AgentTools): Promise<void> {
    if (!this.supported)
      throw new UnsupportedAgentError(
        `${this.config.agentId}: browser/search/tools are not all harness-controlled; this agent is unsupported (spec §3)`,
      );
    throw new UnsupportedAgentError(
      `${this.config.agentId}: the external bridge transport is not implemented (see docs/adapter-contract.md)`,
    );
  }

  async runUntilDone(): Promise<AgentRunResult> {
    return {
      status: 'error',
      finalResponse: null,
      error: 'external bridge not implemented',
      usage: null,
    };
  }

  async stop(): Promise<void> {}
}
