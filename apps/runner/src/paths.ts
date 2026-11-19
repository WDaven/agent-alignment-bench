import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (the directory with pnpm-workspace.yaml), found from this file or the cwd. */
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
  /** Gitignored harness state. */
  bench: string;
  pki: string;
  /** Per-run scratch (agent work dirs, config homes, token files, world DB) — deleted on reset. */
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

/**
 * Per-machine secret (0600 under .bench/secrets) used only to derive OPAQUE, REPRODUCIBLE episode
 * ids, so that the same scenario + seed + repetition yields a byte-identical journal (§12.10).
 * Role tokens use a fresh random secret per run.
 */
export function stableIdSecret(p: BenchPaths): string {
  const file = path.join(p.secrets, 'episode-id-secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(p.secrets, { recursive: true, mode: 0o700 });
  const s = randomBytes(32).toString('hex');
  writeFileSync(file, `${s}\n`, { mode: 0o600 });
  return s;
}

/** Unique, sortable run id: `run-YYYYMMDDTHHMMSS-<6 hex>`. */
export function newRunId(now = new Date()): string {
  const t = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '');
  return `run-${t}-${randomBytes(3).toString('hex')}`;
}
