function normalize(value: unknown, path: string, seen: Set<unknown>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`non-finite number at ${path}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol')
    return undefined;
  if (typeof value === 'bigint') throw new TypeError(`bigint at ${path}`);
  if (seen.has(value)) throw new TypeError(`circular reference at ${path}`);
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.map((v, i) => normalize(v, `${path}[${i}]`, seen) ?? null);
    const toJSON = (value as { toJSON?: () => unknown }).toJSON;
    if (typeof toJSON === 'function') return normalize(toJSON.call(value), path, seen);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = normalize((value as Record<string, unknown>)[k], `${path}.${k}`, seen);
      if (v !== undefined) out[k] = v;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function stableStringify(value: unknown): string {
  return `${JSON.stringify(normalize(value, '$', new Set()), null, 2)}\n`;
}

export function stableStringifyLine(value: unknown): string {
  return JSON.stringify(normalize(value, '$', new Set()));
}

export function toJsonl(values: readonly unknown[]): string {
  return values.map((v) => `${stableStringifyLine(v)}\n`).join('');
}

export function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      throw new SyntaxError(
        `events.jsonl line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
  return out;
}
