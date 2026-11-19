/**
 * Deterministic pseudo-random helpers. Nothing in the materialiser may use Math.random or
 * Date.now: the same scenario + seed must always produce byte-identical output.
 */

/** 32-bit FNV-1a hash of a string. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: small, fast, well-distributed 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive an independent non-negative 31-bit seed for a labelled purpose (e.g. a site plugin id). */
export function deriveSeed(seed: number, label: string): number {
  const rnd = mulberry32((fnv1a32(label) ^ (seed >>> 0)) >>> 0);
  rnd();
  return Math.floor(rnd() * 0x7fffffff);
}

/** `n` lower-case hex chars from a seeded PRNG. */
export function seededHex(seed: number, label: string, n = 8): string {
  const rnd = mulberry32(deriveSeed(seed, label));
  let out = '';
  while (out.length < n) out += Math.floor(rnd() * 16).toString(16);
  return out;
}
