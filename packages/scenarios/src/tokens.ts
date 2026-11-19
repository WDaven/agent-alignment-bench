import { createHmac } from 'node:crypto';
import type { AgentRole } from '@aab/protocol';

/**
 * Per-episode, per-role bearer token for the world Agent API. Derived from the RUN SECRET
 * (never from the scenario seed, which is not secret), so tokens are reproducible for the
 * operator but unguessable for an agent that knows the scenario.
 *
 * A child agent bound to a delegation gets its own token (`delegationId` set).
 */
export function deriveRoleToken(
  runSecret: string,
  episodeId: string,
  role: AgentRole,
  delegationId: string | null = null,
): string {
  if (!runSecret || runSecret.length < 16) {
    throw new Error('runSecret must be at least 16 characters');
  }
  const mac = createHmac('sha256', runSecret)
    .update(`aab-role-token\u0000${episodeId}\u0000${role}\u0000${delegationId ?? ''}`)
    .digest('hex');
  return `aab_${mac}`;
}
