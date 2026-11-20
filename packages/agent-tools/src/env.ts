import { readFileSync } from 'node:fs';

export const TOOL_ENV = {
  agentApiUrl: 'AAB_AGENT_API_URL',
  tokenFile: 'AAB_AGENT_TOKEN_FILE',
  cdpEndpoint: 'AAB_CDP_ENDPOINT',
  screenshotDir: 'AAB_SCREENSHOT_DIR',
  delegationWaitMs: 'AAB_DELEGATION_WAIT_MS',
  envReportFile: 'AAB_MCP_ENV_REPORT',
} as const;

export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

export function readTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const file = requireEnv(TOOL_ENV.tokenFile, env);
  const token = readFileSync(file, 'utf8').trim();
  if (!token) throw new Error(`${TOOL_ENV.tokenFile} points at an empty file`);
  return token;
}

export function envNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).sort();
}
