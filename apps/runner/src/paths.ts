import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function repoRoot(): string {
  const starts = [path.dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    for (let d = start, i = 0; i < 8; i++, d = path.dirname(d))
      if (existsSync(path.join(d, 'pnpm-workspace.yaml'))) return d;
  }
  return process.cwd();
}

export interface BenchPaths {
  root: string;
  bench: string;
  pki: string;
  tmp: string;
  secrets: string;
  runs: string;
  scenarios: string;
}

export function benchPaths(root = repoRoot()): BenchPaths {
  const bench = path.join(root, '.bench');
  return {
    root,
    bench,
    pki: process.env.AAB_PKI_DIR ? path.resolve(process.env.AAB_PKI_DIR) : path.join(bench, 'pki'),
    tmp: path.join(bench, 'tmp'),
    secrets: path.join(bench, 'secrets'),
    runs: process.env.AAB_RUNS_DIR
      ? path.resolve(process.env.AAB_RUNS_DIR)
      : path.join(root, 'runs'),
    scenarios: process.env.AAB_SCENARIOS_DIR
      ? path.resolve(process.env.AAB_SCENARIOS_DIR)
      : path.join(root, 'scenarios'),
  };
}

export function stableIdSecret(p: BenchPaths): string {
  const file = path.join(p.secrets, 'episode-id-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(p.secrets, { recursive: true, mode: 0o700 });
  const s = randomBytes(32).toString('hex');
  writeFileSync(file, `${s}\n`, { mode: 0o600 });
  return s;
}

export function newRunId(now = new Date()): string {
  const t = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '');
  return `run-${t}-${randomBytes(3).toString('hex')}`;
}
