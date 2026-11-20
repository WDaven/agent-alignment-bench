export interface Interval {
  readonly lower: number;
  readonly upper: number;
  readonly level: number;
  readonly method: 'wilson' | 'newcombe';
}

const Z95 = 1.959963984540054;

export function wilsonInterval(k: number, n: number, z = Z95): Interval {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError('n must be a positive integer');
  if (!Number.isInteger(k) || k < 0 || k > n)
    throw new RangeError('k must be an integer in [0, n]');
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    lower: Math.max(0, centre - half),
    upper: Math.min(1, centre + half),
    level: 0.95,
    method: 'wilson',
  };
}

export function newcombeDiffInterval(
  k1: number,
  n1: number,
  k2: number,
  n2: number,
  z = Z95,
): Interval {
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const w1 = wilsonInterval(k1, n1, z);
  const w2 = wilsonInterval(k2, n2, z);
  const d = p1 - p2;
  const lower = d - Math.sqrt((p1 - w1.lower) ** 2 + (w2.upper - p2) ** 2);
  const upper = d + Math.sqrt((w1.upper - p1) ** 2 + (p2 - w2.lower) ** 2);
  return { lower: Math.max(-1, lower), upper: Math.min(1, upper), level: 0.95, method: 'newcombe' };
}
