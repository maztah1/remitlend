import { describe, it, expect } from 'vitest';
import {
  formatMoney,
  formatLedgerEntry,
  formatLedger,
  type LedgerEntry,
} from './format';

describe('formatMoney', () => {
  it('formats USD with symbol placement and grouping', () => {
    expect(formatMoney(1234.5, { locale: 'en-US', currency: 'USD' })).toBe('$1,234.50');
  });

  it('respects locale currency placement', () => {
    expect(formatMoney(1234.5, { locale: 'de-DE', currency: 'EUR' })).toBe('1.234,50\u00a0\u20ac');
  });

  it('formats negative values with sign', () => {
    expect(formatMoney(-1234.5, { locale: 'en-US', currency: 'USD' })).toBe('-$1,234.50');
  });

  it('honours explicit decimal precision', () => {
    expect(formatMoney(1.005, { locale: 'en-US', currency: 'USD', decimals: 3 })).toBe('$1.005');
  });

  it('caps precision to a bounded maximum', () => {
    expect(formatMoney(1.23456789, { locale: 'en-US', currency: 'USD', decimals: 99 })).toBe('$1.23456789');
  });

  it('rejects non-finite and NaN amounts', () => {
    expect(() => formatMoney(NaN, { locale: 'en-US', currency: 'USD' })).toThrow();
    expect(() => formatMoney(Infinity, { locale: 'en-US', currency: 'USD' })).toThrow();
    expect(() => formatMoney(-Infinity, { locale: 'en-US', currency: 'USD' })).toThrow();
  });

  it('rejects invalid currency codes', () => {
    expect(() => formatMoney(1, { locale: 'en-US', currency: 'NOT_A_CURRENCY' })).toThrow();
  });

  it('rejects invalid locales', () => {
    expect(() => formatMoney(1, { locale: 'not a locale', currency: 'USD' })).toThrow();
  });
});

describe('formatLedgerEntry', () => {
  const base: LedgerEntry = {
    id: 'tx-1',
    timestamp: '2024-01-15T12:00:00.000Z',
    amount: 250,
    direction: 'debit',
    balance: 1000,
    currency: 'USD',
  };

  it('formats a debit entry with a negative sign and running balance', () => {
    const out = formatLedgerEntry(base, { locale: 'en-US' });
    expect(out.amount).toBe('-$250.00');
    expect(out.balance).toBe('$1,000.00');
    expect(out.direction).toBe('debit');
    expect(out.date).toMatch(/2024/);
  });

  it('formats a credit entry with a positive sign', () => {
    const out = formatLedgerEntry({ ...base, direction: 'credit' }, { locale: 'en-US' });
    expect(out.amount).toBe('$250.00');
  });

  it('derives signs from authoritative numeric sources, not preformatted strings', () => {
    const out = formatLedgerEntry({ ...base, amount: -250, direction: 'credit' }, { locale: 'en-US' });
    expect(out.amount).toBe('-$250.00');
  });

  it('rejects invalid timestamps', () => {
    expect(() => formatLedgerEntry({ ...base, timestamp: 'not-a-date' }, { locale: 'en-US' })).toThrow();
  });

  it('rejects non-finite amounts and balances', () => {
    expect(() => formatLedgerEntry({ ...base, amount: NaN }, { locale: 'en-US' })).toThrow();
    expect(() => formatLedgerEntry({ ...base, balance: Infinity }, { locale: 'en-US' })).toThrow();
  });
});

describe('formatLedger', () => {
  it('formats a bounded list of entries', () => {
    const entries: LedgerEntry[] = [
      { id: 'a', timestamp: '2024-01-01T00:00:00.000Z', amount: 10, direction: 'credit', balance: 10, currency: 'USD' },
      { id: 'b', timestamp: '2024-01-02T00:00:00.000Z', amount: 5, direction: 'debit', balance: 5, currency: 'USD' },
    ];
    const out = formatLedger(entries, { locale: 'en-US' });
    expect(out).toHaveLength(2);
    expect(out[0].amount).toBe('$10.00');
    expect(out[1].amount).toBe('-$5.00');
  });

  it('caps the number of formatted entries', () => {
    const entries: LedgerEntry[] = Array.from({ length: 500 }, (_, i) => ({
      id: `e-${i}`,
      timestamp: '2024-01-01T00:00:00.000Z',
      amount: 1,
      direction: 'credit' as const,
      balance: i,
      currency: 'USD',
    }));
    expect(formatLedger(entries, { locale: 'en-US', maxEntries: 100 })).toHaveLength(100);
  });
});
