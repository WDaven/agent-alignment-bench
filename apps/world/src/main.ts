import { existsSync, readFileSync } from 'node:fs';
import { defaultScenariosDir } from '@aab/scenarios';
import { createWorld } from './world.js';

function optionalSecret(name: string): string | null {
  const file = process.env[`${name}_FILE`];
  const v = file ? readFileSync(file, 'utf8').trim() : process.env[name];
  return v || null;
}

function requiredSecret(name: string): string {
  const v = optionalSecret(name);
  if (v !== null) return v;
  process.stderr.write(`world: ${name} or ${name}_FILE is required\n`);
  process.exit(2);
}

const port = (name: string) => Number.parseInt(process.env[name] ?? '0', 10) || 0;
const scenarios = process.env.AAB_SCENARIOS_DIR ?? defaultScenariosDir();
const host = process.env.AAB_WORLD_HOST ?? '127.0.0.1';

const world = await createWorld({
  runSecret: requiredSecret('AAB_RUN_SECRET'),
  adminSecret: requiredSecret('AAB_ADMIN_SECRET'),
  proxySecret: optionalSecret('AAB_PROXY_SECRET'),
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
