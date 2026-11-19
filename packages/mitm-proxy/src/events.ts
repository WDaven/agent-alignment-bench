import type { ProxyListener, RunEventDraft } from '@aab/protocol';

export type NetworkEventType = 'network.request' | 'network.tunnel' | 'network.denied';

/** Protocol-shaped draft (`RunEventDraft`); the world fills eventId/episodeId/seq/clock. */
export type NetworkEventDraft = Extract<RunEventDraft, { eventType: NetworkEventType }>;

export interface NetworkEventContext {
  /** Episode of the listener the traffic arrived on (RunEventDraft has no episodeId). */
  episodeId: string;
  listener: Readonly<ProxyListener>;
  /** Bound port of that listener. */
  port: number;
  /** Local label of the listener (`purpose`), e.g. `browser` or `cli`. */
  purpose: string;
}

/**
 * Supplied by the caller (the world service journals these). Called synchronously; must not
 * throw (errors are caught and reported through `onError`). The proxy never writes to SQLite.
 */
export type NetworkEventSink = (event: NetworkEventDraft, ctx: NetworkEventContext) => void;
