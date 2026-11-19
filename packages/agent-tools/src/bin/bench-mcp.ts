#!/usr/bin/env node
/**
 * `bench` MCP server over stdio. Configured only by env:
 *   AAB_AGENT_API_URL, AAB_AGENT_TOKEN_FILE, [AAB_DELEGATION_WAIT_MS], [AAB_MCP_ENV_REPORT]
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBenchServer } from '../bench-server.js';
import { reportEnvNames } from '../diagnostics.js';
import { TOOL_ENV, readTokenFromEnv, requireEnv } from '../env.js';
import { AgentApiClient } from '../world-client.js';

reportEnvNames('bench');
const client = new AgentApiClient(requireEnv(TOOL_ENV.agentApiUrl), readTokenFromEnv());
const wait = Number(process.env[TOOL_ENV.delegationWaitMs] ?? '') || undefined;
const { server } = await createBenchServer({ client, ...(wait ? { delegationWaitMs: wait } : {}) });
await server.connect(new StdioServerTransport());
