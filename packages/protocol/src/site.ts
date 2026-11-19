import type { ActionName, ActionRequestInput, WorldOpResponse } from './actions.js';
import type { AgentRole, Host } from './common.js';
import type { TrapExposureKindSchema } from './events.js';
import type { ScenarioSpec, TrapPublic, WorldFixture } from './scenario.js';
import type { z } from 'zod';

/** Context of the call, used to fill event envelopes. */
export interface WorldOpCallContext {
  /** Page the action was taken from (e.g. the checkout page URL). */
  pageUrl?: string;
  /** MCP tool call that triggered it, if any. */
  toolCallId?: string;
}

/**
 * Typed client for world operations, already bound to one episode and one role (and, for a
 * child agent, its delegation). Implemented by apps/world; consumed by site plugins and the
 * bench MCP server. Every call is journaled as an attempt; a denial is a normal return value
 * (`ok: false`), not an exception. Exceptions mean harness errors.
 */
export interface WorldOpsClient {
  readonly episodeId: string;
  readonly role: AgentRole;
  readonly delegationId: string | null;
  call<A extends ActionName>(
    action: A,
    request: ActionRequestInput<A>,
    ctx?: WorldOpCallContext,
  ): Promise<WorldOpResponse<A>>;
}

/**
 * The site-facing view of the materialised fixture. Excludes the hidden `expected` answer key;
 * still contains canonical truths (e.g. `meetsRequirements`, real resource kinds) that a site
 * must not print verbatim unless the scenario intends it.
 */
export interface MaterializedFixture {
  readonly episodeId: string;
  readonly scenarioId: string;
  readonly seed: number;
  readonly world: WorldFixture;
  /** Only the traps targeting this site's hosts. Empty in clean variants. */
  readonly traps: readonly TrapPublic[];
  /** User-visible task text (some sites, e.g. an inbox, may echo it). */
  readonly userTask: ScenarioSpec['userTask'];
}

export type TrapExposureKind = z.infer<typeof TrapExposureKindSchema>;

/** Records that trap content was delivered (emits `trap.exposed`). Idempotent per (trapId, url). */
export interface TrapExposureRecorder {
  recordExposure(
    trapId: string,
    details: { url: string | null; exposureKind: TrapExposureKind },
  ): Promise<void>;
}

/** Minimal request facts a site passes to `resolve`. Framework-agnostic. */
export interface SiteRequestInfo {
  /** Lower-cased header map as received from the proxy. */
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Absolute URL, e.g. `https://shop-a.eval.test/cart`. */
  url: string;
  method: string;
}

/** Per-request scope derived from the proxy's trusted x-bench-* headers. */
export interface SiteRequestScope {
  readonly episodeId: string;
  readonly role: AgentRole;
  readonly delegationId: string | null;
  readonly ops: WorldOpsClient;
  readonly fixture: MaterializedFixture;
  readonly traps: TrapExposureRecorder;
}

export interface SiteContext {
  /**
   * Resolve the episode/role of a request from trusted headers (TRUSTED_HEADERS). Throws if they
   * are missing or name no active episode: sites must not serve unscoped requests.
   */
  resolve(req: SiteRequestInfo): SiteRequestScope;
  /** Deterministic per-episode RNG seed derived from the scenario seed and the plugin id. */
  seedFor(episodeId: string): number;
}

/**
 * Contract for a simulated website (architecture.md: sites are out of scope for now; the
 * built-in `probe.eval.test` diagnostic host implements it).
 *
 * `TServer` is the HTTP server handle provided by apps/world (a Fastify instance, opaque to
 * protocol so this package has no framework dependency). Sites must register routes scoped to
 * their own hosts, render pages from the fixture, and perform consequential actions ONLY via
 * `scope.ops.call(...)`; page text can never mutate the ledger directly.
 */
export interface SitePlugin<TServer = unknown> {
  /** Stable plugin id, referenced by `world.sites[].plugin`. */
  readonly id: string;
  /** Exact `*.eval.test` hosts this plugin serves by default. */
  readonly hosts: readonly Host[];
  register(server: TServer, ctx: SiteContext): void | Promise<void>;
}
