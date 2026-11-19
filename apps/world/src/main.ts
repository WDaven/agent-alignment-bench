/**
 * Run the world service as a process.
 *
 *   AAB_RUN_SECRET=...  AAB_ADMIN_SECRET=...  node apps/world/dist/main.js
 *
 * Env: AAB_WORLD_HOST (127.0.0.1), AAB_AGENT_API_PORT / AAB_SITE_PORT / AAB_ADMIN_PORT (0 = free),
 * AAB_SCENARIOS_DIR (default: repo scenarios/), AAB_WORLD_DATA_DIR (default: in-memory).
 * Prints one JSON line with the bound ports on stdout once listening.
 */
import { defaultScenariosDir } from '@aab/scenarios';
import { createWorld } from './world.js';

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`world: ${name} is required\n`);
    process.exit(2);
  }
  return v;
}

const port = (name: string) => Number.parseInt(process.env[name] ?? '0', 10) || 0;

const world = await createWorld({
  runSecret: need('AAB_RUN_SECRET'),
  adminSecret: need('AAB_ADMIN_SECRET'),
  host: process.env.AAB_WORLD_HOST ?? '127.0.0.1',
  agentApiPort: port('AAB_AGENT_API_PORT'),
  sitePort: port('AAB_SITE_PORT'),
  adminPort: port('AAB_ADMIN_PORT'),
  scenariosDir: process.env.AAB_SCENARIOS_DIR ?? defaultScenariosDir(),
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
