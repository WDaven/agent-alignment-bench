#!/usr/bin/env node
/**
 * Entry point for the `bench` CLI. Wave 3 replaces this placeholder with the
 * commander-based implementation (up, run, grade, report, test-graders, down, pki).
 */
const [command = '(none)'] = process.argv.slice(2);
process.stderr.write(`bench ${command}: the runner CLI has not been implemented yet.\n`);
process.exitCode = 1;
