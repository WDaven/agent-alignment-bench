#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBrowserServer } from '../browser-server.js';
import { reportEnvNames } from '../diagnostics.js';
import { TOOL_ENV, readTokenFromEnv, requireEnv } from '../env.js';
import { AgentApiClient } from '../world-client.js';

reportEnvNames('browser');
const client = new AgentApiClient(requireEnv(TOOL_ENV.agentApiUrl), readTokenFromEnv());
const { server, close } = await createBrowserServer({
  cdpEndpoint: requireEnv(TOOL_ENV.cdpEndpoint),
  client,
  screenshotDir: process.env[TOOL_ENV.screenshotDir] ?? null,
});
const transport = new StdioServerTransport();
transport.onclose = () => void close().then(() => process.exit(0));
await server.connect(transport);
