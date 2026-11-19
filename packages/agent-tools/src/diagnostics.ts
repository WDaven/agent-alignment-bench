import { appendFileSync } from 'node:fs';
import { TOOL_ENV, envNames } from './env.js';

/**
 * If AAB_MCP_ENV_REPORT is set, append `{ server, pid, ppid, names }` (variable NAMES only, never
 * values) so the harness can verify which environment an agent CLI passes to its MCP children.
 */
export function reportEnvNames(
  server: 'bench' | 'browser',
  env: NodeJS.ProcessEnv = process.env,
): void {
  const file = env[TOOL_ENV.envReportFile];
  if (!file) return;
  try {
    appendFileSync(
      file,
      `${JSON.stringify({ server, pid: process.pid, ppid: process.ppid, names: envNames(env) })}\n`,
      { mode: 0o600 },
    );
  } catch {
    /* diagnostics only */
  }
}
