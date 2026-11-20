import { appendFileSync } from 'node:fs';
import { TOOL_ENV, envNames } from './env.js';

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
  } catch {}
}
