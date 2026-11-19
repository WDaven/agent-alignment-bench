import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  ActionNameSchema,
  DENIAL_REASON_CATEGORY,
  EpisodeSchema,
  RunEventSchema,
  ScenarioSpecSchema,
  type ActionName,
  type ActionVia,
  type AgentRole,
  type Episode,
  type EventType,
  type Isolation,
  type Role,
  type RunEvent,
  type ScenarioSpec,
  type WorldOpResponse,
  type WorldState,
} from '@aab/protocol';
import { SqliteJournal } from './journal.js';
import { planAction, type EffectDraft } from './planner.js';
import type { Actor } from './policy.js';
import { applyEvent, initialProjection, replay, type Projection } from './projection.js';
import { attemptIdFor, eventIdFor, jsonClone, stableStringify } from './util.js';

/** Event types other components (proxy, browser, site host, agent tools, runner) may journal. */
export const INGESTIBLE_EVENT_TYPES = [
  'network.request',
  'network.tunnel',
  'network.denied',
  'page.navigated',
  'trap.exposed',
  'tool.call',
  'agent.final_response',
] as const satisfies readonly EventType[];
export type IngestibleEventType = (typeof INGESTIBLE_EVENT_TYPES)[number];

/** Virtual clock: each attempt is an agent "step" of 1 s; every other event advances 1 ms. */
export const VIRTUAL_MS_PER_ATTEMPT = 1000;
export const VIRTUAL_MS_PER_EVENT = 1;

export class UnknownActionError extends Error {
  override name = 'UnknownActionError';
}
export class IngestError extends Error {
  override name = 'IngestError';
}

export interface ExecuteContext extends Actor {
  via: ActionVia;
  toolCallId?: string | null;
  pageUrl?: string | null;
}

export interface WorldStoreOptions {
  spec: ScenarioSpec;
  episode: Episode;
  /** SQLite file path; default in-memory. */
  dbPath?: string;
  isolation?: Isolation;
  /** Extra hosts `browse` reports as existing (e.g. hosts with a registered site plugin). */
  knownHosts?: readonly string[];
}

/** Draft accepted by `ingest` (envelope fields the world assigns are not accepted). */
export interface IngestDraft {
  eventType: IngestibleEventType;
  role: Role;
  delegationId?: string | null;
  pageUrl?: string | null;
  payload: unknown;
}

/**
 * Authoritative world state for ONE episode: SQLite journal + projection + policy.
 * All mutation goes through `append`, which assigns seq/eventId/virtual time, validates the
 * event against the protocol, persists it and folds it into the projection.
 *
 * Synchronous by design: Node runs one call at a time, so seq assignment cannot interleave.
 */
export class WorldStore {
  readonly spec: ScenarioSpec;
  readonly episode: Episode;
  private readonly journal: SqliteJournal;
  private projection: Projection;
  private readonly initial: Projection;
  private readonly cache: RunEvent[] = [];
  private readonly lines: string[] = [];
  private readonly knownHosts: Set<string>;
  private readonly listeners = new Set<(e: RunEvent) => void>();

  private constructor(
    spec: ScenarioSpec,
    episode: Episode,
    journal: SqliteJournal,
    knownHosts: readonly string[],
  ) {
    this.spec = spec;
    this.episode = episode;
    this.journal = journal;
    this.initial = initialProjection(spec, episode.id);
    this.projection = this.initial;
    const w = spec.world;
    this.knownHosts = new Set([
      ...knownHosts,
      ...w.products.map((p) => p.merchant),
      ...w.searchIndex.map((d) => new URL(d.url).hostname),
      ...w.sites.map((s) => s.host),
      ...w.traps.flatMap((t) => (t.host ? [t.host] : [])),
    ]);
  }

  /** Create a fresh episode database and journal `episode.started` (seq 0). */
  static create(opts: WorldStoreOptions): WorldStore {
    const spec = ScenarioSpecSchema.parse(opts.spec);
    const episode = EpisodeSchema.parse(opts.episode);
    if (episode.scenarioId !== spec.id) throw new Error('episode does not belong to this scenario');
    if (opts.dbPath && opts.dbPath !== ':memory:')
      mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    const journal = new SqliteJournal(opts.dbPath ?? ':memory:');
    if (journal.rows().length > 0) {
      journal.close();
      throw new Error(`database ${opts.dbPath} already contains events; use WorldStore.open`);
    }
    journal.setMeta('spec', stableStringify(spec));
    journal.setMeta('episode', stableStringify(episode));
    journal.setMeta('knownHosts', JSON.stringify([...(opts.knownHosts ?? [])]));
    const store = new WorldStore(spec, episode, journal, opts.knownHosts ?? []);
    store.append({
      eventType: 'episode.started',
      role: 'world',
      delegationId: null,
      pageUrl: null,
      payload: {
        runId: episode.runId,
        scenarioId: spec.id,
        pairId: spec.pairId,
        variant: spec.variant,
        seed: episode.seed,
        fixtureVersion: spec.fixtureVersion,
        worldFixtureId: episode.worldFixtureId,
        benchmarkIds: spec.benchmarkIds,
        isolation: opts.isolation ?? 'proxy-only',
      },
    });
    return store;
  }

  /** Re-open an existing episode database; the projection is rebuilt from the journal alone. */
  static open(dbPath: string): WorldStore {
    const journal = new SqliteJournal(dbPath);
    const spec = ScenarioSpecSchema.parse(JSON.parse(journal.getMeta('spec') ?? 'null'));
    const episode = EpisodeSchema.parse(JSON.parse(journal.getMeta('episode') ?? 'null'));
    const hosts = JSON.parse(journal.getMeta('knownHosts') ?? '[]') as string[];
    const store = new WorldStore(spec, episode, journal, hosts);
    for (const row of journal.rows()) {
      const e = RunEventSchema.parse(JSON.parse(row.json));
      store.cache.push(e);
      store.lines.push(row.json);
      store.projection = applyEvent(spec, store.projection, e);
    }
    return store;
  }

  get episodeId(): string {
    return this.episode.id;
  }

  /** Live projection (a copy). */
  state(): WorldState {
    return jsonClone(this.projection.world);
  }

  /** Projection before any event (asOfSeq = -1). */
  initialState(): WorldState {
    return jsonClone(this.initial.world);
  }

  get episodeActive(): boolean {
    return !this.projection.aux.episodeEnded;
  }

  events(): RunEvent[] {
    return jsonClone(this.cache);
  }

  get nextSeq(): number {
    return this.cache.length;
  }

  // -------------------------------------------------------------------------
  // journal
  // -------------------------------------------------------------------------

  private append(draft: {
    eventType: EventType;
    role: Role;
    delegationId: string | null;
    pageUrl: string | null;
    payload: unknown;
  }): RunEvent {
    const seq = this.cache.length;
    const prevMs = this.cache[seq - 1]?.occurredAtVirtualMs ?? 0;
    const occurredAtVirtualMs =
      seq === 0
        ? 0
        : prevMs +
          (draft.eventType === 'action.attempted' ? VIRTUAL_MS_PER_ATTEMPT : VIRTUAL_MS_PER_EVENT);
    const candidate = {
      eventId: eventIdFor(seq),
      episodeId: this.episode.id,
      seq,
      occurredAtVirtualMs,
      role: draft.role,
      delegationId: draft.delegationId,
      pageUrl: draft.pageUrl,
      eventType: draft.eventType,
      payload: draft.payload,
    };
    // Canonical form = what is written to disk; round-trip so live and replayed objects match.
    const json = stableStringify(candidate);
    const event = RunEventSchema.parse(JSON.parse(json));
    const next = applyEvent(this.spec, this.projection, event);
    this.journal.append(
      {
        seq,
        eventId: event.eventId,
        episodeId: event.episodeId,
        eventType: event.eventType,
        role: event.role,
        occurredAtVirtualMs,
        json,
      },
      stableStringify(next),
    );
    this.cache.push(event);
    this.lines.push(json);
    this.projection = next;
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* listeners must not break the journal */
      }
    }
    return event;
  }

  // -------------------------------------------------------------------------
  // world operations
  // -------------------------------------------------------------------------

  /**
   * Execute one typed world operation for an actor. The raw request is journaled as
   * `action.attempted` BEFORE validation or any policy decision; then the domain events and
   * exactly one `action.committed` / `action.denied` follow. Denials are return values.
   *
   * Throws UnknownActionError (nothing journaled) if `action` is not in the catalogue; callers
   * that want such calls journaled use `executeUnknown` (an `action.unknown` event).
   */
  execute(ctx: ExecuteContext, action: string, rawRequest: unknown): WorldOpResponse<ActionName> {
    const parsedAction = ActionNameSchema.safeParse(action);
    if (!parsedAction.success) throw new UnknownActionError(`unknown action ${action}`);
    return this.executeKnown(ctx, parsedAction.data, rawRequest);
  }

  /**
   * Journal a call to an operation that is not in the catalogue as one `action.unknown` event
   * (attempt + `unknown_action` denial). Nothing else changes. Returns the denial response.
   */
  executeUnknown(
    ctx: ExecuteContext,
    requestedAction: string,
    rawRequest: unknown,
  ): {
    ok: false;
    action: string;
    attemptId: string;
    denial: { reason: 'unknown_action'; message: string };
  } {
    if (!this.episodeActive) throw new IngestError('episode has ended');
    const name = String(requestedAction).slice(0, 128);
    const attemptId = `${attemptIdFor(this.projection.world.attempts.length + 1)}-u${this.projection.world.lifecycle.unknownActionAttempts + 1}`;
    this.append({
      role: ctx.role as Role,
      delegationId: ctx.delegationId ?? null,
      pageUrl: ctx.pageUrl ?? null,
      eventType: 'action.unknown',
      payload: {
        attemptId,
        requestedAction: name,
        request: rawRequest === undefined ? {} : rawRequest,
        via: ctx.via,
        toolCallId: ctx.toolCallId ?? null,
        reason: 'unknown_action',
      },
    });
    return {
      ok: false,
      action: name,
      attemptId,
      denial: { reason: 'unknown_action', message: `there is no world operation named ${name}` },
    };
  }

  /** Subscribe to every appended event (synchronous, after it is persisted). Returns unsubscribe. */
  onEvent(listener: (e: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private executeKnown(
    ctx: ExecuteContext,
    a: ActionName,
    rawRequest: unknown,
  ): WorldOpResponse<ActionName> {
    const envelope = {
      role: ctx.role as Role,
      delegationId: ctx.delegationId ?? null,
      pageUrl: ctx.pageUrl ?? null,
    };
    const attemptId = attemptIdFor(this.projection.world.attempts.length + 1);
    this.append({
      ...envelope,
      eventType: 'action.attempted',
      payload: {
        attemptId,
        action: a,
        request: rawRequest === undefined ? {} : rawRequest,
        via: ctx.via,
        toolCallId: ctx.toolCallId ?? null,
      },
    });

    let plan;
    try {
      plan = planAction({
        spec: this.spec,
        projection: this.projection,
        actor: { role: ctx.role, delegationId: ctx.delegationId ?? null },
        action: a,
        // Plan on the journaled (canonical JSON) request, exactly what a replay would see.
        request: (
          this.cache[this.cache.length - 1] as Extract<RunEvent, { eventType: 'action.attempted' }>
        ).payload.request,
        attemptId,
        knownHosts: this.knownHosts,
      });
    } catch (err) {
      plan = {
        ok: false as const,
        reason: 'internal_error' as const,
        message: `internal error: ${err instanceof Error ? err.message : String(err)}`,
        authorizationDecision: 'not_applicable' as const,
      };
    }

    if (!plan.ok) {
      this.append({
        ...envelope,
        eventType: 'action.denied',
        payload: {
          attemptId,
          action: a,
          reason: plan.reason,
          category: DENIAL_REASON_CATEGORY[plan.reason],
          message: plan.message,
          authorizationDecision: plan.authorizationDecision,
        },
      });
      return {
        ok: false,
        action: a,
        attemptId,
        denial: { reason: plan.reason, message: plan.message },
      };
    }

    for (const eff of plan.effects) this.appendEffect(envelope, eff);
    const committed = this.append({
      ...envelope,
      eventType: 'action.committed',
      payload: {
        attemptId,
        action: a,
        result: plan.result,
        authorizationDecision: plan.authorizationDecision,
      },
    }) as Extract<RunEvent, { eventType: 'action.committed' }>;
    return {
      ok: true,
      action: a,
      attemptId,
      result: committed.payload.result,
    } as WorldOpResponse<ActionName>;
  }

  private appendEffect(
    envelope: { role: Role; delegationId: string | null; pageUrl: string | null },
    eff: EffectDraft,
  ): RunEvent {
    return this.append({
      ...envelope,
      ...(eff.role
        ? { role: eff.role, delegationId: eff.role === 'world' ? null : envelope.delegationId }
        : {}),
      eventType: eff.eventType,
      payload: eff.payload,
    });
  }

  // -------------------------------------------------------------------------
  // externally produced events
  // -------------------------------------------------------------------------

  /**
   * Journal an event produced outside the world (proxy, browser, site host, agent tools,
   * runner). The world assigns eventId/episodeId/seq/virtual time; the payload is validated
   * against the protocol. Returns null when a `trap.exposed` is a duplicate (idempotent).
   */
  ingest(draft: IngestDraft): RunEvent | null {
    if (!draft || typeof draft !== 'object') throw new IngestError('event draft must be an object');
    if (!(INGESTIBLE_EVENT_TYPES as readonly string[]).includes(draft.eventType))
      throw new IngestError(`event type ${String(draft.eventType)} cannot be ingested`);
    const allowedKeys = new Set(['eventType', 'role', 'delegationId', 'pageUrl', 'payload']);
    for (const k of Object.keys(draft))
      if (!allowedKeys.has(k)) throw new IngestError(`field ${k} is assigned by the world`);
    if (draft.eventType === 'trap.exposed') {
      const p = draft.payload as { trapId?: unknown; url?: unknown };
      if (!this.spec.world.traps.some((t) => t.id === p?.trapId))
        throw new IngestError(`unknown trap ${String(p?.trapId)}`);
      const key = `${String(p.trapId)}\u0000${typeof p.url === 'string' ? p.url : ''}`;
      if (this.projection.aux.trapExposures.includes(key)) return null;
    }
    // Validate before touching the journal so a bad draft never consumes a seq.
    const probe = RunEventSchema.safeParse({
      eventId: 'evt-probe',
      episodeId: this.episode.id,
      seq: this.cache.length,
      occurredAtVirtualMs: 0,
      role: draft.role,
      delegationId: draft.delegationId ?? null,
      pageUrl: draft.pageUrl ?? null,
      eventType: draft.eventType,
      payload: draft.payload,
    });
    if (!probe.success)
      throw new IngestError(
        probe.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      );
    return this.append({
      eventType: draft.eventType,
      role: draft.role,
      delegationId: draft.delegationId ?? null,
      pageUrl: draft.pageUrl ?? null,
      payload: draft.payload,
    });
  }

  /** TrapExposureRecorder backend: emits `trap.exposed` once per (trapId, url). */
  recordTrapExposure(
    actor: { role: AgentRole; delegationId: string | null },
    trapId: string,
    details: {
      url: string | null;
      exposureKind: 'rendered' | 'search_result' | 'api_response' | 'subagent_report';
    },
  ): RunEvent | null {
    const trap = this.spec.world.traps.find((t) => t.id === trapId);
    if (!trap) throw new IngestError(`unknown trap ${trapId}`);
    return this.ingest({
      eventType: 'trap.exposed',
      role: actor.role,
      delegationId: actor.delegationId,
      pageUrl: details.url,
      payload: {
        trapId,
        trapType: trap.type,
        surface: trap.surface,
        url: details.url,
        exposureKind: details.exposureKind,
      },
    });
  }

  /** Runner request: a child agent finished. */
  endDelegation(
    delegationId: string,
    status: 'completed' | 'timeout' | 'error' | 'cancelled',
    finalResponse: string | null = null,
  ): RunEvent {
    const d = this.projection.world.delegations.find((x) => x.delegationId === delegationId);
    if (!d) throw new IngestError(`unknown delegation ${delegationId}`);
    if (d.status !== 'active')
      throw new IngestError(`delegation ${delegationId} already ${d.status}`);
    return this.append({
      eventType: 'delegation.ended',
      role: 'world',
      delegationId: null,
      pageUrl: null,
      payload: { delegationId, status, finalResponse },
    });
  }

  /** Runner request: the episode is over. Later attempts are denied `episode_not_active`. */
  endEpisode(p: {
    reason:
      'final_response' | 'max_steps' | 'timeout' | 'agent_error' | 'harness_error' | 'aborted';
    agentStatus?: 'done' | 'timeout' | 'error' | null;
    error?: string | null;
  }): RunEvent {
    if (!this.episodeActive) throw new IngestError('episode already ended');
    return this.append({
      eventType: 'episode.ended',
      role: 'world',
      delegationId: null,
      pageUrl: null,
      payload: {
        reason: p.reason,
        agentStatus: p.agentStatus ?? null,
        error: p.error ?? null,
        stepsUsed: this.projection.world.attempts.length,
      },
    });
  }

  // -------------------------------------------------------------------------
  // rebuild / export
  // -------------------------------------------------------------------------

  /** Recompute the projection from the SQLite journal alone (ignores in-memory state). */
  rebuildFromJournal(): WorldState {
    const events = this.journal.rows().map((r) => RunEventSchema.parse(JSON.parse(r.json)));
    return replay(this.spec, this.episode.id, events).world;
  }

  /** The projection cached in SQLite (written in the same transaction as each event). */
  storedProjection(): WorldState | null {
    const p = this.journal.storedProjection();
    return p ? (JSON.parse(p.json) as Projection).world : null;
  }

  /** events.jsonl: one canonical (sorted-key) JSON event per line, by seq. */
  exportEventsJsonl(): string {
    return this.lines.map((l) => `${l}\n`).join('');
  }

  exportFinalState(): string {
    return `${stableStringify(this.projection.world, 2)}\n`;
  }

  exportInitialState(): string {
    return `${stableStringify(this.initial.world, 2)}\n`;
  }

  /** Write `events.jsonl`, `world-final.json`, `world-initial.json` into `dir`. */
  writeArtifacts(dir: string): {
    eventsPath: string;
    finalStatePath: string;
    initialStatePath: string;
  } {
    mkdirSync(dir, { recursive: true });
    const eventsPath = path.join(dir, 'events.jsonl');
    const finalStatePath = path.join(dir, 'world-final.json');
    const initialStatePath = path.join(dir, 'world-initial.json');
    writeFileSync(eventsPath, this.exportEventsJsonl());
    writeFileSync(finalStatePath, this.exportFinalState());
    writeFileSync(initialStatePath, this.exportInitialState());
    return { eventsPath, finalStatePath, initialStatePath };
  }

  /** Direct access for tests that need to prove the journal is immutable. */
  get sqlite() {
    return this.journal.db;
  }

  close(): void {
    this.journal.close();
  }
}
