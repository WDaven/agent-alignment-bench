#!/usr/bin/env node
// Fake agent CLI for adapter tests. Records argv + env to $FAKE_CLI_RECORD, prints the lines of
// $FAKE_CLI_SCRIPT (JSONL; a line {"sleepMs":n} sleeps; {"spawnChild":true} starts a grandchild
// that writes its pid to $FAKE_CLI_RECORD.child), then exits with $FAKE_CLI_EXIT (default 0).
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write('9.9.9 (fake)\n');
  process.exit(0);
}
if (process.env.FAKE_CLI_RECORD)
  writeFileSync(
    process.env.FAKE_CLI_RECORD,
    JSON.stringify({ argv: args, env: process.env, cwd: process.cwd() }),
  );
const lines = process.env.FAKE_CLI_SCRIPT
  ? readFileSync(process.env.FAKE_CLI_SCRIPT, 'utf8').split('\n').filter(Boolean)
  : [];
for (const l of lines) {
  const o = JSON.parse(l);
  if (o.sleepMs) await new Promise((r) => setTimeout(r, o.sleepMs));
  else if (o.spawnChild) {
    const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    writeFileSync(`${process.env.FAKE_CLI_RECORD}.child`, String(c.pid));
  } else process.stdout.write(`${l}\n`);
}
process.exit(Number(process.env.FAKE_CLI_EXIT ?? 0));
