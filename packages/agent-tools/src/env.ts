/**
 * Configuration of the two MCP servers. They are configured ONLY by environment variables (and
 * the files they point at), never by tool arguments, so nothing the model sends can redirect them.
 *
 * The role token is read from a file (mode 0600, written by the runner) so it never appears in
 * argv (`ps`), in the CLI's MCP config, in tool descriptions or in tool results.
 */
import { readFileSync } from 'node:fs';

export const TOOL_ENV = {
  /** World Agent API base URL, e.g. `http://127.0.0.1:7800`. */
  agentApiUrl: 'AAB_AGENT_API_URL',
  /** File containing the per-episode, per-role bearer token. */
  tokenFile: 'AAB_AGENT_TOKEN_FILE',
  /** CDP endpoint of this role's Chromium (`http://127.0.0.1:<port>`), browser server only. */
  cdpEndpoint: 'AAB_CDP_ENDPOINT',
  /** Directory for screenshots taken by the browser tool (optional). */
  screenshotDir: 'AAB_SCREENSHOT_DIR',
  /** Max wait (ms) of the bench `delegate` tool for the child to finish (default 600000). */
  delegationWaitMs: 'AAB_DELEGATION_WAIT_MS',
  /**
   * Diagnostics: if set, the server appends one JSON line with the NAMES (never values) of the
   * environment variables it received to this file. Used to verify what env each CLI passes to
   * its MCP children.
   */
  envReportFile: 'AAB_MCP_ENV_REPORT',
} as const;

export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

/** Read the bearer token from the file named by AAB_AGENT_TOKEN_FILE. */
export function readTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const file = requireEnv(TOOL_ENV.tokenFile, env);
  const token = readFileSync(file, 'utf8').trim();
  if (!token) throw new Error(`${TOOL_ENV.tokenFile} points at an empty file`);
  return token;
}

/** Secret-looking variable names (for env reports: names are listed, never values). */
export function envNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).sort();
}
