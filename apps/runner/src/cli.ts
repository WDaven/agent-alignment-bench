#!/usr/bin/env node
/**
 * `bench` — the benchmark CLI (pnpm bench:* scripts).
 *
 *   bench pki init|show|rotate
 *   bench up [--compose] | bench down [--compose]
 *   bench run (--scenario <id> | --suite <s>) --agent scripted|claude-code|codex
 *             [--model m] [--seed n] [--repetitions k] [--headed] [--auth inherit|api_key]
 *             [--no-browser] [--max-turns n] [--max-budget-usd x] [--plan compliant|probe] [--compose]
 *   bench grade --events runs/<id>/events.jsonl [--write]
 *   bench report --run <id> | --suite-dir <dir>
 *   bench test-graders
 *   bench doctor [--no-self-test]
 */
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import {
  caPaths,
  ensureTrustMaterial,
  loadCa,
  readLeafSpkiFingerprint,
  rotateCa,
  trustEnv,
  writeTrustBundle,
} from '@aab/pki';
import { AGENT_CLI_QUIET_ENV } from '@aab/mitm-proxy';
import { ScenarioCatalog } from '@aab/scenarios';
import type { CliAuthMode } from '@aab/agent-adapters';
import { compose, dockerAvailable, prepareCompose, remoteBackendFromEnv } from './compose.js';
import { doctor } from './doctor.js';
import { runEpisode } from './episode.js';
import { benchPaths } from './paths.js';
import { regradeRun, renderReportFor, writeRegrade, writeSuiteSummary } from './regrade.js';
import type { AgentKindName } from './agents.js';

const p = benchPaths();
const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);
const int = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0)
    throw new InvalidArgumentError('expected a non-negative integer');
  return n;
};

const program = new Command('bench')
  .description('Agent Alignment Browser Benchmark harness')
  .showHelpAfterError();

// ---------------------------------------------------------------- pki
async function printPki(): Promise<void> {
  const ca = await loadCa(p.pki);
  const x = new X509Certificate(ca.certPem);
  const cp = caPaths(p.pki);
  out(`eval CA: ${cp.certPath}`);
  out(`  subject      ${ca.cert.subject}`);
  out(`  sha256       ${x.fingerprint256}`);
  out(`  valid        ${x.validFrom} → ${x.validTo}`);
  out(`  constraint   critical nameConstraints: permitted DNS:eval.test (IP ranges excluded)`);
  out(
    `  chromium pin ${await readLeafSpkiFingerprint(p.pki)} (--ignore-certificate-errors-spki-list)`,
  );
  out('');
  out(
    '# trust env for a process that must reach *.eval.test through the proxy (never installed system-wide):',
  );
  for (const [k, v] of Object.entries(trustEnv(p.pki))) out(`export ${k}=${v}`);
  out('# private keys (never printed): ca-key.pem, leaf-key.pem (mode 0600)');
}
const pki = program
  .command('pki')
  .description('per-machine eval CA (name-constrained to eval.test)');
pki
  .command('init')
  .description('create the CA if missing (idempotent) and print it')
  .action(async () => {
    await ensureTrustMaterial(p.pki);
    await printPki();
  });
pki
  .command('show')
  .description('print fingerprint and trust env')
  .action(async () => {
    if (!existsSync(caPaths(p.pki).certPath)) {
      err(`no CA in ${p.pki}; run: pnpm bench:pki init`);
      process.exitCode = 1;
      return;
    }
    await printPki();
  });
pki
  .command('rotate')
  .description('replace CA and leaf key')
  .action(async () => {
    const ca = await rotateCa(p.pki);
    await writeTrustBundle(ca);
    await printPki();
  });

// ---------------------------------------------------------------- up / down
program
  .command('up')
  .description('prepare the harness (local: PKI + dirs; --compose: docker compose up)')
  .option('--compose', 'start world + proxy + runner containers (isolation: container)')
  .action(async (o: { compose?: boolean }) => {
    await ensureTrustMaterial(p.pki);
    if (o.compose) {
      if (!dockerAvailable()) throw new Error('docker compose is not available');
      prepareCompose(p);
      process.exitCode = compose(p, ['up', '-d', '--build', 'world', 'proxy']);
      return;
    }
    out('Local mode needs no daemon: every `bench run` self-hosts a fresh world (agent API, site');
    out('host, admin API) and MITM proxy in its own process for each episode and tears them down');
    out('afterwards (isolation: proxy-only). PKI is ready in ' + p.pki + '.');
    out('For hard isolation use: pnpm bench:up -- --compose');
  });
program
  .command('down')
  .description('local: remove leftover per-run scratch; --compose: docker compose down')
  .option('--compose')
  .action((o: { compose?: boolean }) => {
    if (o.compose) {
      process.exitCode = compose(p, ['down', '--remove-orphans']);
      return;
    }
    if (existsSync(p.tmp)) {
      const n = readdirSync(p.tmp).length;
      rmSync(p.tmp, { recursive: true, force: true });
      out(`removed ${n} leftover run scratch dir(s) from ${p.tmp}`);
    } else out('nothing to clean up');
  });

// ---------------------------------------------------------------- run
program
  .command('run')
  .description('run episodes and write runs/<runId>/')
  .option('--scenario <id>', 'scenario id')
  .option('--suite <suite>', 'b0..b7, a suite dir, tag:B4, all (comma-separated)')
  .requiredOption('--agent <agent>', 'scripted | claude-code | codex')
  .option('--model <model>', 'model passed to the CLI')
  .option('--seed <n>', 'override the scenario seed', int)
  .option('--repetitions <k>', 'repetitions per scenario', int, 1)
  .option('--headed', 'show the browser')
  .option('--no-browser', 'do not launch Chromium (bench tools only)')
  .option('--auth <mode>', 'api_key (key from env) | inherit (your existing CLI login)', 'api_key')
  .option('--max-turns <n>', 'kill the CLI after this many tool calls', int)
  .option('--max-budget-usd <x>', 'Claude Code spend guard', parseFloat)
  .option('--plan <name>', 'scripted agent plan: compliant | probe', 'compliant')
  .option('--compose', 'run inside the runner container (docker compose)')
  .action(async (o) => {
    if (o.compose) {
      const argv = process.argv.slice(process.argv.indexOf('run')).filter((a) => a !== '--compose');
      // The runner image's entrypoint is `node apps/runner/dist/cli.js`; AAB_BACKEND=remote there.
      process.exitCode = compose(p, ['--profile', 'run', 'run', '--rm', 'runner', ...argv]);
      return;
    }
    const kind = String(o.agent) as AgentKindName;
    if (!['scripted', 'claude-code', 'codex'].includes(kind))
      throw new Error(`unknown agent ${kind}`);
    if (!!o.scenario === !!o.suite) throw new Error('give exactly one of --scenario or --suite');
    const catalog = ScenarioCatalog.loadDir(p.scenarios);
    const ids: string[] = o.scenario ? [String(o.scenario)] : catalog.resolveSuite(String(o.suite));
    const backend = process.env.AAB_BACKEND === 'remote' ? remoteBackendFromEnv() : undefined;
    const results = [];
    for (const id of ids) {
      const g = catalog.getForGrader(id);
      for (let rep = 0; rep < (o.repetitions as number); rep++) {
        const r = await runEpisode({
          spec: g.spec,
          expected: g.expected,
          agent: {
            kind,
            spec: g.spec,
            model: o.model ?? null,
            auth: o.auth as CliAuthMode,
            ...(o.maxTurns ? { maxTurns: o.maxTurns } : {}),
            ...(o.maxBudgetUsd ? { maxBudgetUsd: o.maxBudgetUsd } : {}),
            planName: o.plan === 'probe' ? 'probe' : 'compliant',
          },
          ...(o.seed !== undefined ? { seed: o.seed } : {}),
          repetition: rep,
          suite: o.suite ?? null,
          headed: !!o.headed,
          browser: o.browser !== false,
          paths: p,
          ...(backend ? { backend } : {}),
          log: (l) => err(`[bench] ${l}`),
        });
        results.push(r);
        const gl = r.grade.report.global;
        const v = r.grade.report.grades.flatMap((x) =>
          x.violations.map((y) => `${x.benchmark}:${y.code}`),
        );
        out(
          `${r.runId}  ${id}  end=${r.endReason}  task_success=${gl.task_success}  policy_compliance=${gl.policy_compliance}  violations=[${[...new Set(v)].join(', ')}]  warnings=${r.grade.validationWarnings.length}`,
        );
        out(`  artifacts: ${r.runDir}  report: ${path.join(r.runDir, 'report.html')}`);
      }
    }
    await backend?.close();
    if (results.length > 1) {
      // Suite summary in a dedicated directory of links (runs stay in runs/<runId>/).
      const s = writeSuiteSummary(p.runs, `Runs (${results.length} new)`);
      out(`suite summary: ${s.file} (${s.runs} runs under ${p.runs})`);
    }
  });

// ---------------------------------------------------------------- grade / report
program
  .command('grade')
  .description('re-grade a run from its artifacts (events.jsonl + episode/world files)')
  .requiredOption('--events <path>', 'runs/<runId>/events.jsonl')
  .option('--write', 'rewrite grades.json and report.html')
  .action((o: { events: string; write?: boolean }) => {
    const dir = path.dirname(path.resolve(o.events));
    const result = o.write ? writeRegrade(dir, p.scenarios) : regradeRun(dir, p.scenarios).result;
    out(JSON.stringify(result.report, null, 2));
    if (result.validationWarnings.length)
      err(`validation warnings: ${result.validationWarnings.join('; ')}`);
  });
program
  .command('report')
  .description('render report.html for a run, or a summary over a directory of runs')
  .option('--run <id>', 'run id under runs/')
  .option('--suite-dir <dir>', 'directory containing run directories')
  .action((o: { run?: string; suiteDir?: string }) => {
    if (o.run) {
      const dir = path.isAbsolute(o.run) ? o.run : path.join(p.runs, o.run);
      if (!existsSync(dir)) throw new Error(`no run directory ${dir}`);
      out(renderReportFor(dir));
    } else if (o.suiteDir) {
      const s = writeSuiteSummary(path.resolve(o.suiteDir));
      out(`${s.file} (${s.runs} runs)`);
    } else throw new Error('give --run <id> or --suite-dir <dir>');
  });

// ---------------------------------------------------------------- test-graders / doctor
program
  .command('test-graders')
  .description('run the grader contract tests (crafted positive/negative traces, spec §12.11)')
  .action(() => {
    const r = spawnSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', 'packages/graders/', 'tests/grader-contract/'],
      { cwd: p.root, stdio: 'inherit' },
    );
    process.exitCode = r.status ?? 1;
  });
program
  .command('doctor')
  .description('check node, chromium, CA, CLIs and the proxy path')
  .option('--no-self-test', 'skip the Chromium → proxy → world self-test')
  .action(async (o: { selfTest?: boolean }) => {
    const checks = await doctor(p, { selfTest: o.selfTest !== false });
    for (const c of checks)
      out(`${c.ok ? 'ok  ' : c.optional ? 'warn' : 'FAIL'}  ${c.name}: ${c.detail}`);
    out(`quiet env for agent CLIs: ${Object.keys(AGENT_CLI_QUIET_ENV).join(', ')}`);
    if (checks.some((c) => !c.ok && !c.optional)) process.exitCode = 1;
  });

program.parseAsync(process.argv).catch((e: unknown) => {
  err(`bench: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
