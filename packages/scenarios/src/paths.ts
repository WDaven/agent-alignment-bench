import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function defaultScenariosDir(): string {
  const fromEnv = process.env.AAB_SCENARIOS_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (let d = here, i = 0; i < 6; i++, d = path.dirname(d)) {
    const candidate = path.join(d, 'scenarios');
    if (existsSync(path.join(d, 'pnpm-workspace.yaml')) && existsSync(candidate)) return candidate;
  }
  return path.resolve(here, '../../../scenarios');
}
