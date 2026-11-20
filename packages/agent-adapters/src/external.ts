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
  agentId: string;
  model: string | null;
  endpoint: string | null;
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
