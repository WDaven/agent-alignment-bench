/**
 * Run the world service as a process (docker: apps/world image).
 *
 *   AAB_RUN_SECRET[_FILE]=...  AAB_ADMIN_SECRET[_FILE]=...  [AAB_PROXY_SECRET[_FILE]=...]
 *   node apps/world/dist/main.js
 *
 * Env: AAB_WORLD_HOST (agent API bind, 127.0.0.1), AAB_SITE_HOST (site host bind, default
 * AAB_WORLD_HOST), AAB_ADMIN_HOST (admin bind, 127.0.0.1), AAB_AGENT_API_PORT / AAB_SITE_PORT /
 * AAB_ADMIN_PORT (0 = free), AAB_SCENARIOS_DIR (optional; enables materialise-by-id),
 * AAB_WORLD_DATA_DIR (default: in-memory). With a proxy secret the site host refuses every request
 * that did not come through the MITM proxy. Prints one JSON line with the bound ports.
 */
import { existsSync, readFileSync } from 'node:fs';
import { defaultScenariosDir } from '@aab/scenarios';
import { createWorld } from './world.js';

function secret(name: string, required: boolean): string | null {
  const file = process.env[`${name}_FILE`];
  const v = file ? readFileSync(file, 'utf8').trim() : process.env[name];
  if (!v && required) {
    process.stderr.write(`world: ${name} or ${name}_FILE is required\n`);
    process.exit(2);
  }
  return v || null;
}

const port = (name: string) => Number.parseInt(process.env[name] ?? '0', 10) || 0;
const scenarios = process.env.AAB_SCENARIOS_DIR ?? defaultScenariosDir();
const host = process.env.AAB_WORLD_HOST ?? '127.0.0.1';

const world = await createWorld({
  runSecret: secret('AAB_RUN_SECRET', true)!,
  adminSecret: secret('AAB_ADMIN_SECRET', true)!,
  proxySecret: secret('AAB_PROXY_SECRET', false),
  host,
  siteHost: process.env.AAB_SITE_HOST ?? host,
  adminHost: process.env.AAB_ADMIN_HOST ?? '127.0.0.1',
  agentApiPort: port('AAB_AGENT_API_PORT'),
  sitePort: port('AAB_SITE_PORT'),
  adminPort: port('AAB_ADMIN_PORT'),
  scenariosDir: existsSync(scenarios) ? scenarios : null,
  dataDir: process.env.AAB_WORLD_DATA_DIR ?? null,
});

process.stdout.write(
  `${JSON.stringify({ host: world.host, agentApiPort: world.agentApiPort, sitePort: world.sitePort, adminPort: world.adminPort })}\n`,
);

const stop = () => {
  void world.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
