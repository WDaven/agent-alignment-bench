import { usd, type Money } from '@aab/protocol';

/** JSON with object keys sorted recursively; `undefined` members are dropped (like JSON.stringify). */
export function stableStringify(value: unknown, indent?: number): string {
  return JSON.stringify(sortKeys(value), null, indent);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : sortKeys(x)));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortKeys(x);
    }
    return out;
  }
  return v;
}

/** Deep copy through JSON (the journal's own canonical representation). */
export function jsonClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export const pad6 = (n: number) => String(n).padStart(6, '0');

/** `att-000017` for the 17th attempt of an episode. */
export function attemptIdFor(n: number): string {
  return `att-${pad6(n)}`;
}

/** World ids derived from the attempt that created them: `ord-000017`, `clm-000017`, ... */
export function derivedId(prefix: string, attemptId: string): string {
  return `${prefix}-${attemptId.replace(/^att-/, '')}`;
}

export function eventIdFor(seq: number): string {
  return `evt-${pad6(seq)}`;
}

export const cents = (m: Money | null | undefined) => (m ? m.cents : 0);
export const money = (c: number): Money => usd(c);
export const minC = (a: number, b: number) => (a < b ? a : b);
