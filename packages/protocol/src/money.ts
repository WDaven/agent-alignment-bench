import { z } from 'zod';

export const CurrencySchema = z.literal('USD');
export type Currency = z.infer<typeof CurrencySchema>;

export const MoneySchema = z.strictObject({
  cents: z.number().int().refine(Number.isSafeInteger, 'cents must be a safe integer'),
  currency: CurrencySchema,
});
export type Money = z.infer<typeof MoneySchema>;

export const NonNegativeMoneySchema = MoneySchema.refine((m) => m.cents >= 0, {
  message: 'amount must be >= 0 cents',
});

export class MoneyError extends Error {
  override name = 'MoneyError';
}

function assertCents(cents: number, label = 'cents'): void {
  if (!Number.isSafeInteger(cents)) {
    throw new MoneyError(`${label} must be a safe integer number of cents, got ${String(cents)}`);
  }
}

function assertMoney(m: Money, label: string): void {
  if (m === null || typeof m !== 'object') throw new MoneyError(`${label} is not a Money value`);
  if (m.currency !== 'USD')
    throw new MoneyError(`${label} has unsupported currency ${String(m.currency)}`);
  assertCents(m.cents, `${label}.cents`);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function usd(cents: number): Money {
  assertCents(cents);
  return { cents, currency: 'USD' };
}

export const ZERO_USD: Readonly<Money> = Object.freeze(usd(0));

export function addMoney(a: Money, b: Money): Money {
  assertMoney(a, 'a');
  assertMoney(b, 'b');
  assertSameCurrency(a, b);
  const cents = a.cents + b.cents;
  assertCents(cents, 'result');
  return { cents, currency: a.currency };
}

export function subMoney(a: Money, b: Money): Money {
  assertMoney(a, 'a');
  assertMoney(b, 'b');
  assertSameCurrency(a, b);
  const cents = a.cents - b.cents;
  assertCents(cents, 'result');
  return { cents, currency: a.currency };
}

export function sumMoney(values: readonly Money[]): Money {
  return values.reduce<Money>((acc, v) => addMoney(acc, v), usd(0));
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertMoney(a, 'a');
  assertMoney(b, 'b');
  assertSameCurrency(a, b);
  return a.cents < b.cents ? -1 : a.cents > b.cents ? 1 : 0;
}

export function moneyEquals(a: Money, b: Money): boolean {
  return compareMoney(a, b) === 0;
}

export function minMoney(a: Money, b: Money): Money {
  return compareMoney(a, b) <= 0 ? a : b;
}

export function maxMoney(a: Money, b: Money): Money {
  return compareMoney(a, b) >= 0 ? a : b;
}

export function formatMoney(m: Money): string {
  assertMoney(m, 'm');
  const sign = m.cents < 0 ? '-' : '';
  const abs = Math.abs(m.cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
