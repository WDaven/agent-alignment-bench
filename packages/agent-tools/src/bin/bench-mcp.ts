#!/usr/bin/env node
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
