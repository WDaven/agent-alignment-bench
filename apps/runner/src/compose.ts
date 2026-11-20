import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildProxyPolicy } from '@aab/mitm-proxy';
import type { ProxyConfigInput } from '@aab/protocol';
import { RemoteBackend } from './backend.js';
import type { BenchPaths } from './paths.js';

export const COMPOSE_NET = {
  proxyAgentIp: '172.30.0.2',
  proxyHarnessIp: '172.29.0.2',
  proxyWorldIp: '172.31.0.2',
  worldAgentIp: '172.30.0.3',
  worldHarnessIp: '172.29.0.3',
  worldSiteIp: '172.31.0.3',
  agentApiPort: 7800,
  sitePort: 7810,
  adminPort: 7820,
  controlPort: 8090,
} as const;

function secretFile(dir: string, name: string): string {
  const f = path.join(dir, name);
  if (!existsSync(f))
    writeFileSync(f, `${randomBytes(24).toString('base64url')}\n`, { mode: 0o600 });
  return f;
}

export function prepareCompose(p: BenchPaths): { dir: string } {
  const dir = path.join(p.bench, 'docker');
  const secrets = path.join(dir, 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  for (const n of ['proxy-secret', 'control-token', 'admin-secret', 'run-secret'])
    secretFile(secrets, n);
  const n = COMPOSE_NET;
  const config: ProxyConfigInput = {
    listeners: [],
    policy: buildProxyPolicy(),
    worldSiteUpstream: {
      host: n.worldSiteIp,
      port: n.sitePort,
      secretFile: '/secrets/proxy-secret',
    },
    internalEndpoints: [
      { host: n.worldAgentIp, port: n.agentApiPort },
      { host: n.worldHarnessIp, port: n.adminPort },
      { host: n.worldHarnessIp, port: n.agentApiPort },
    ],
    ca: { certPath: '/pki/ca.pem', keyPath: '/pki/ca-key.pem' },
    control: { host: n.proxyHarnessIp, port: n.controlPort, tokenFile: '/secrets/control-token' },
  };
  writeFileSync(path.join(dir, 'proxy.json'), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return { dir };
}

export function compose(p: BenchPaths, args: readonly string[]): number {
  const r = spawnSync(
    'docker',
    ['compose', '-f', path.join(p.root, 'docker-compose.yml'), ...args],
    {
      cwd: p.root,
      stdio: 'inherit',
    },
  );
  return r.status ?? 1;
}

export function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function remoteBackendFromEnv(env: NodeJS.ProcessEnv = process.env): RemoteBackend {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is required for AAB_BACKEND=remote`);
    return v;
  };
  const read = (k: string) => readFileSync(need(k), 'utf8').trim();
  return new RemoteBackend({
    adminUrl: need('AAB_WORLD_ADMIN_URL'),
    adminSecret: read('AAB_ADMIN_SECRET_FILE'),
    agentApiUrl: need('AAB_WORLD_AGENT_API_URL'),
    proxyControlUrl: need('AAB_PROXY_CONTROL_URL'),
    proxyControlToken: read('AAB_PROXY_CONTROL_TOKEN_FILE'),
    proxyHost: need('AAB_PROXY_HOST'),
  });
}
