import { existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { caPaths, ensureTrustMaterial, hasEvalNameConstraint, loadCa } from '@aab/pki';
import { launchControlledBrowser } from '@aab/browser';
import { PROBE_HOST } from '@aab/protocol';
import { ScenarioCatalog } from '@aab/scenarios';
import { LocalBackend } from './backend.js';
import type { BenchPaths } from './paths.js';

function firstLine(text: string): string {
  const end = text.indexOf('\n');
  return end === -1 ? text : text.slice(0, end);
}

const execFileP = promisify(execFile);

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  optional?: boolean;
}

async function version(cmd: string): Promise<string | null> {
  try {
    return (
      (await execFileP(cmd, ['--version'], { timeout: 15_000 })).stdout.trim().split('\n')[0] ??
      null
    );
  } catch {
    return null;
  }
}

export async function doctor(p: BenchPaths, opts: { selfTest?: boolean } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const [maj, min] = process.versions.node.split('.').map(Number) as [number, number];
  checks.push({
    name: 'node',
    ok: maj > 22 || (maj === 22 && min >= 12),
    detail: `${process.version} (need >= 22.12; node:sqlite)`,
  });
  const exe = chromium.executablePath();
  checks.push({
    name: 'chromium',
    ok: existsSync(exe),
    detail: existsSync(exe) ? exe : `missing — run: pnpm exec playwright install chromium`,
  });
  const cp = caPaths(p.pki);
  if (!existsSync(cp.certPath)) {
    checks.push({
      name: 'eval CA',
      ok: false,
      detail: `none in ${p.pki} — run: pnpm bench:pki init`,
    });
  } else {
    try {
      const ca = await loadCa(p.pki);
      const constrained = hasEvalNameConstraint(ca.cert);
      const keyMode = statSync(cp.keyPath).mode & 0o777;
      const leafMode = statSync(cp.leafKeyPath).mode & 0o777;
      checks.push({
        name: 'eval CA',
        ok: constrained && keyMode === 0o600 && leafMode === 0o600 && existsSync(cp.bundlePath),
        detail: `name constraint ${constrained ? 'intact (critical, permitted DNS:eval.test)' : 'MISSING'}; key modes ${keyMode.toString(8)}/${leafMode.toString(8)}; bundle ${existsSync(cp.bundlePath) ? 'present' : 'missing'}; expires ${ca.cert.notAfter.toISOString().slice(0, 10)}`,
      });
    } catch (err) {
      checks.push({ name: 'eval CA', ok: false, detail: String(err) });
    }
  }
  for (const [name, cmd, want] of [
    ['claude CLI', 'claude', '2.1.224'],
    ['codex CLI', 'codex', '0.169.0'],
  ] as const) {
    const v = await version(cmd);
    checks.push({
      name,
      ok: v !== null,
      optional: true,
      detail: v
        ? `${v}${v.includes(want) ? '' : ` (adapters were verified against ${want})`}`
        : 'not found on PATH',
    });
  }
  checks.push({
    name: 'scenarios',
    ok: (() => {
      try {
        return ScenarioCatalog.loadDir(p.scenarios).ids().length > 0;
      } catch {
        return false;
      }
    })(),
    detail: p.scenarios,
  });

  if (opts.selfTest !== false && checks.every((c) => c.ok || c.optional))
    checks.push(...(await proxySelfTest(p)));
  return checks;
}

export async function proxySelfTest(p: BenchPaths): Promise<Check[]> {
  const out: Check[] = [];
  const ca = await ensureTrustMaterial(p.pki);
  const backend = await LocalBackend.start({
    ca,
    runSecret: randomBytes(24).toString('hex'),
    presets: [],
    dataDir: null,
  });
  const tmp = path.join(os.tmpdir(), `aab-doctor-${randomBytes(4).toString('hex')}`);
  try {
    const catalog = ScenarioCatalog.loadDir(p.scenarios);
    const firstId = catalog.ids()[0];
    if (firstId === undefined) throw new Error(`no scenarios in ${p.scenarios}`);
    const spec = catalog.getForWorld(firstId).spec;
    const m = await backend.materialize({
      spec,
      seed: spec.seed,
      runId: 'run-doctor',
      episodeId: 'ep-doctor',
    });
    const l = await backend.addListener({
      episodeId: m.episode.id,
      role: 'parent',
      delegationId: null,
      host: '127.0.0.1',
      port: 0,
      purpose: 'browser',
    });
    const b = await launchControlledBrowser({
      proxyPort: l.port,
      caDir: p.pki,
      artifactsDir: tmp,
      headless: true,
      trace: false,
      har: false,
    });
    try {
      const page = await b.page();
      const res = await page.goto(`https://${PROBE_HOST}/`).catch((e: Error) => e);
      const role = res instanceof Error ? null : await page.textContent('#role');
      out.push({
        name: `proxy self-test: https://${PROBE_HOST}`,
        ok: role === 'parent',
        detail:
          res instanceof Error
            ? firstLine(res.message)
            : `HTTP ${res?.status()}, role shown: ${role}`,
      });
      const ex = await page.goto('https://example.com/').then(
        () => 'loaded (BAD)',
        (e: Error) => firstLine(e.message),
      );
      const evs = await backend.events(m.episode.id);
      const denied = evs.some(
        (e) => e.eventType === 'network.denied' && e.payload.host === 'example.com',
      );
      out.push({
        name: 'proxy self-test: https://example.com denied',
        ok: denied && !ex.startsWith('loaded'),
        detail: `${ex}; network.denied journaled: ${denied}`,
      });
    } finally {
      await b.close();
    }
  } catch (err) {
    out.push({
      name: 'proxy self-test',
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    await backend.close();
  }
  return out;
}
