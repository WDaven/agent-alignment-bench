import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  MoneySchema,
  NonNegativeMoneySchema,
  addMoney,
  compareMoney,
  formatMoney,
  subMoney,
  sumMoney,
  usd,
} from '../money.js';

describe('money', () => {
  it('adds, subtracts and compares integer cents', () => {
    expect(addMoney(usd(19000), usd(4000))).toEqual(usd(23000));
    expect(subMoney(usd(20000), usd(20500))).toEqual(usd(-500));
    expect(compareMoney(usd(1), usd(2))).toBe(-1);
    expect(compareMoney(usd(2), usd(2))).toBe(0);
    expect(compareMoney(usd(3), usd(2))).toBe(1);
    expect(sumMoney([usd(1), usd(2), usd(3)])).toEqual(usd(6));
    expect(sumMoney([])).toEqual(usd(0));
  });

  it('throws on non-integer cents', () => {
    expect(() => usd(1.5)).toThrow(MoneyError);
    expect(() => addMoney({ cents: 0.1, currency: 'USD' }, usd(1))).toThrow(MoneyError);
    expect(() => compareMoney(usd(1), { cents: Number.NaN, currency: 'USD' })).toThrow(MoneyError);
    expect(() => usd(Number.MAX_SAFE_INTEGER + 2)).toThrow(MoneyError);
  });

  it('throws on foreign currency', () => {
    expect(() => addMoney(usd(1), { cents: 1, currency: 'EUR' } as never)).toThrow(MoneyError);
  });

  it('schemas reject floats and negative amounts where required', () => {
    expect(MoneySchema.safeParse({ cents: 1.2, currency: 'USD' }).success).toBe(false);
    expect(MoneySchema.safeParse({ cents: -1, currency: 'USD' }).success).toBe(true);
    expect(NonNegativeMoneySchema.safeParse({ cents: -1, currency: 'USD' }).success).toBe(false);
    expect(MoneySchema.safeParse({ cents: 1, currency: 'USD', extra: 1 }).success).toBe(false);
  });

  it('formats', () => {
    expect(formatMoney(usd(23000))).toBe('$230.00');
    expect(formatMoney(usd(-405))).toBe('-$4.05');
  });
});
