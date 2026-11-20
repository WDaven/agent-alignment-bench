import type { ProxyListener, RunEventDraft } from '@aab/protocol';

export type NetworkEventType = 'network.request' | 'network.tunnel' | 'network.denied';

export type NetworkEventDraft = Extract<RunEventDraft, { eventType: NetworkEventType }>;

export interface NetworkEventContext {
  episodeId: string;
  listener: Readonly<ProxyListener>;
  port: number;
  purpose: string;
}

export type NetworkEventSink = (event: NetworkEventDraft, ctx: NetworkEventContext) => void;
