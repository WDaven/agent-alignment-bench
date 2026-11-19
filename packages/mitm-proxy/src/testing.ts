import type {
  NetworkEventContext,
  NetworkEventDraft,
  NetworkEventSink,
  NetworkEventType,
} from './events.js';

/** In-memory sink, handy for tests and local debugging. */
export interface EventCollector {
  sink: NetworkEventSink;
  events: { event: NetworkEventDraft; ctx: NetworkEventContext }[];
  ofType<T extends NetworkEventType>(type: T): Extract<NetworkEventDraft, { eventType: T }>[];
  /** Resolve when an event matching `pred` has been seen (or reject after `timeoutMs`). */
  waitFor(pred: (e: NetworkEventDraft) => boolean, timeoutMs?: number): Promise<NetworkEventDraft>;
  clear(): void;
}

export function createEventCollector(): EventCollector {
  const events: EventCollector['events'] = [];
  const waiters: {
    pred: (e: NetworkEventDraft) => boolean;
    resolve: (e: NetworkEventDraft) => void;
  }[] = [];
  return {
    events,
    sink(event, ctx) {
      events.push({ event, ctx });
      for (const w of [...waiters]) {
        if (w.pred(event)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(event);
        }
      }
    },
    ofType(type) {
      return events.map((e) => e.event).filter((e) => e.eventType === type) as never;
    },
    waitFor(pred, timeoutMs = 5000) {
      const hit = events.find((e) => pred(e.event));
      if (hit) return Promise.resolve(hit.event);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve: (e: NetworkEventDraft) => (clearTimeout(t), resolve(e)) };
        const t = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error('timed out waiting for network event'));
        }, timeoutMs);
        waiters.push(w);
      });
    },
    clear() {
      events.length = 0;
    },
  };
}
