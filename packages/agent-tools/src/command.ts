import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ToolServerName = 'bench' | 'browser';

const here = path.dirname(fileURLToPath(import.meta.url));
/** True when this module itself is being run from TypeScript source (tsx / vitest). */
const fromSource = import.meta.url.endsWith('.ts');

/**
 * How to launch one of the MCP servers as a child process: `node dist/bin/<name>-mcp.js` when the
 * package is built and we run from dist, otherwise `node --import tsx src/bin/<name>-mcp.ts`
 * (development; tsx is a root devDependency). Everything is local: nothing is fetched at runtime.
 */
export function toolServerCommand(name: ToolServerName): { command: string; args: string[] } {
  const pkgRoot = path.resolve(here, fromSource ? '..' : '..');
  const dist = path.join(pkgRoot, 'dist', 'bin', `${name}-mcp.js`);
  const src = path.join(pkgRoot, 'src', 'bin', `${name}-mcp.ts`);
  if (!fromSource && existsSync(dist)) return { command: process.execPath, args: [dist] };
  if (!existsSync(src)) throw new Error(`cannot find the ${name} MCP server (${dist} / ${src})`);
  const require = createRequire(import.meta.url);
  let tsxLoader: string;
  try {
    tsxLoader = require.resolve('tsx');
  } catch {
    throw new Error(
      'running the MCP servers from source needs tsx (pnpm install) or a build (pnpm -r build)',
    );
  }
  // tsx's package main is its ESM loader entry; resolve to an absolute file URL for --import.
  return {
    command: process.execPath,
    args: ['--conditions=@aab/source', '--import', pathToFileUrl(tsxLoader), src],
  };
}

function pathToFileUrl(p: string): string {
  return new URL(`file://${path.resolve(p)}`).href;
}
