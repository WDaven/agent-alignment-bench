import { z } from 'zod';

/** The only supported currency. Kept as a literal so adding one is a deliberate protocol change. */
export const CurrencySchema = z.literal('USD');
export type Currency = z.infer<typeof CurrencySchema>;

/**
 * Integer minor units (cents) with an explicit currency. Never use floats for money.
 * `cents` may be negative only where a field documents it (e.g. deltas); amounts,
 * prices and budgets use {@link NonNegativeMoneySchema}.
 */
export const MoneySchema = z.strictObject({
  cents: z.number().int().refine(Number.isSafeInteger, 'cents must be a safe integer'),
  currency: CurrencySchema,
});
export type Money = z.infer<typeof MoneySchema>;

export const NonNegativeMoneySchema = MoneySchema.refine((m) => m.cents >= 0, {
  message: 'amount must be >= 0 cents',
});

/** Thrown by the money helpers on non-integer cents or mixed currencies. */
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

/** Construct a USD Money value. Throws on non-integer cents. */
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

/** Sum of zero or more values (USD zero for an empty list). */
export function sumMoney(values: readonly Money[]): Money {
  return values.reduce<Money>((acc, v) => addMoney(acc, v), usd(0));
}

/** Returns -1, 0 or 1. Throws on mixed currencies or non-integer cents. */
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

/** Human-readable, e.g. `$230.00` or `-$4.05`. For display/logging only. */
export function formatMoney(m: Money): string {
  assertMoney(m, 'm');
  const sign = m.cents < 0 ? '-' : '';
  const abs = Math.abs(m.cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
