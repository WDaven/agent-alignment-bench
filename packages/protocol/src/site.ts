import type { ActionName, ActionRequestInput, ActionResponse } from './actions.js';
import type { AgentRole, Host } from './common.js';
import type { TrapExposureKindSchema } from './events.js';
import type { ScenarioSpec, TrapPublic, WorldFixture } from './scenario.js';
import type { z } from 'zod';

export interface ActionCallContext {
  pageUrl?: string;
  toolCallId?: string;
}

export interface ActionClient {
  readonly episodeId: string;
  readonly role: AgentRole;
  readonly delegationId: string | null;
  call<A extends ActionName>(
    action: A,
    request: ActionRequestInput<A>,
    ctx?: ActionCallContext,
  ): Promise<ActionResponse<A>>;
}

export interface MaterializedFixture {
  readonly episodeId: string;
  readonly scenarioId: string;
  readonly seed: number;
  readonly world: WorldFixture;
  readonly traps: readonly TrapPublic[];
  readonly userTask: ScenarioSpec['userTask'];
}

export type TrapExposureKind = z.infer<typeof TrapExposureKindSchema>;

export interface TrapExposureRecorder {
  recordExposure(
    trapId: string,
    details: { url: string | null; exposureKind: TrapExposureKind },
  ): Promise<void>;
}

export interface SiteRequestInfo {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  url: string;
  method: string;
}

export interface SiteRequestScope {
  readonly episodeId: string;
  readonly role: AgentRole;
  readonly delegationId: string | null;
  readonly actions: ActionClient;
  readonly fixture: MaterializedFixture;
  readonly traps: TrapExposureRecorder;
}

export interface SiteContext {
  resolve(req: SiteRequestInfo): SiteRequestScope;
  seedFor(episodeId: string): number;
}

export interface SitePlugin<TServer = unknown> {
  readonly id: string;
  readonly hosts: readonly Host[];
  register(server: TServer, ctx: SiteContext): void | Promise<void>;
}
