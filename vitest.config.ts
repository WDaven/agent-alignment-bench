import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

type Workspace = { name: string; dir: string };

/** Every workspace package under apps/* and packages/* (discovered, so new packages need no edit here). */
const workspaces: Workspace[] = ['apps', 'packages'].flatMap((group) => {
  const groupDir = path.join(repoRoot, group);
  if (!existsSync(groupDir)) return [];
  return readdirSync(groupDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(groupDir, d.name, 'package.json')))
    .map((d) => {
      const dir = path.join(groupDir, d.name);
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name: string;
      };
      return { name: pkg.name, dir };
    });
});

/** Resolve `@aab/<pkg>` to its TypeScript source so tests never need a prior build. */
const alias = workspaces.map((w) => ({
  find: new RegExp(`^${w.name.replace('/', '\\/')}$`),
  replacement: path.join(w.dir, 'src', 'index.ts'),
}));

export default defineConfig({
  resolve: { alias },
  test: {
    passWithNoTests: true,
    projects: [
      ...workspaces.map((w) => ({
        extends: true as const,
        test: {
          name: w.name,
          root: w.dir,
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
        },
      })),
      {
        extends: true as const,
        test: {
          name: 'repo-tests',
          root: path.join(repoRoot, 'tests'),
          include: ['**/*.test.ts'],
        },
      },
    ],
  },
});
