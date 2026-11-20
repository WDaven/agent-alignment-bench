import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { COMPOSE_NET } from './compose.js';
import { repoRoot } from './paths.js';

type ComposeService = {
  networks: Record<string, { ipv4_address?: string } | null>;
  environment?: Record<string, string>;
  volumes?: string[];
};

const root = repoRoot();
const compose = parse(readFileSync(path.join(root, 'docker-compose.yml'), 'utf8')) as {
  services: Record<string, ComposeService>;
};

function ipOf(service: string, network: string): string | undefined {
  return compose.services[service]?.networks[network]?.ipv4_address;
}

describe('docker-compose.yml matches COMPOSE_NET', () => {
  it('uses the static addresses the runner expects', () => {
    expect(ipOf('proxy', 'agent_net')).toBe(COMPOSE_NET.proxyAgentIp);
    expect(ipOf('proxy', 'harness_net')).toBe(COMPOSE_NET.proxyHarnessIp);
    expect(ipOf('proxy', 'world_net')).toBe(COMPOSE_NET.proxyWorldIp);
    expect(ipOf('world', 'agent_net')).toBe(COMPOSE_NET.worldAgentIp);
    expect(ipOf('world', 'harness_net')).toBe(COMPOSE_NET.worldHarnessIp);
    expect(ipOf('world', 'world_net')).toBe(COMPOSE_NET.worldSiteIp);
  });

  it('binds the world listeners on the documented networks and ports', () => {
    const env = compose.services.world?.environment ?? {};
    expect(env.AAB_WORLD_HOST).toBe(COMPOSE_NET.worldAgentIp);
    expect(env.AAB_SITE_HOST).toBe(COMPOSE_NET.worldSiteIp);
    expect(env.AAB_ADMIN_HOST).toBe(COMPOSE_NET.worldHarnessIp);
    expect(Number(env.AAB_AGENT_API_PORT)).toBe(COMPOSE_NET.agentApiPort);
    expect(Number(env.AAB_SITE_PORT)).toBe(COMPOSE_NET.sitePort);
    expect(Number(env.AAB_ADMIN_PORT)).toBe(COMPOSE_NET.adminPort);
  });

  it('keeps the runner off the world network and away from private keys', () => {
    const runner = compose.services.runner;
    expect(runner).toBeDefined();
    expect(Object.keys(runner?.networks ?? {}).sort()).toEqual(['agent_net', 'harness_net']);
    const env = runner?.environment ?? {};
    expect(env.AAB_PROXY_CONTROL_URL).toBe(
      `http://${COMPOSE_NET.proxyHarnessIp}:${COMPOSE_NET.controlPort}`,
    );
    expect(env.AAB_PROXY_HOST).toBe(COMPOSE_NET.proxyAgentIp);
    const mounts = (runner?.volumes ?? []).join('\n');
    expect(mounts).not.toMatch(/ca-key\.pem|leaf-key\.pem|proxy-secret|run-secret/);
    expect(mounts).not.toMatch(/\.bench\/pki:/);
  });

  it('builds the runner on the Playwright image matching the installed playwright', () => {
    const dockerfile = readFileSync(path.join(root, 'docker/runner.Dockerfile'), 'utf8');
    const image = /mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)/.exec(dockerfile)?.[1];
    const manifest = createRequire(import.meta.url).resolve('playwright/package.json');
    const installed = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
    expect(image).toBe(installed.version);
  });
});
