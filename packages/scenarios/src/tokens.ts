import { createHmac } from 'node:crypto';
import type { AgentRole } from '@aab/protocol';

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
