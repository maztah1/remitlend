/**
 * Locale-aware formatting utilities for money and ledger values.
 *
 * All numeric inputs are treated as authoritative values (e.g. minor units
 * already resolved by the backend). These helpers only format; they never
 * perform financial arithmetic or mutate persisted data.
 */

const DEFAULT_LOCALE = 'en-US';
const DEFAULT_CURRENCY = 'USD';

/** Maximum number of fraction digits we will ever render. */
const MAX_FRACTION_DIGITS = 8;
/** Upper bound on rendered string length to keep resource usage bounded. */
const MAX_OUTPUT_LENGTH = 128;

/**
 * A single ledger entry as consumed by the UI. Amounts are authoritative
 * numeric values supplied by the API; `direction` distinguishes debits from
 * credits without relying on sign conventions in the wire format.
 */
export interface LedgerEntry {
  /** ISO 8601 timestamp of the entry. */
  timestamp: string | number | Date;
  /** Authoritative amount, always a non-negative magnitude. */
  amount: number;
  /** Debit or credit classification. */
  direction: 'debit' | 'credit';
  /** Optional running balance after this entry. */
  balance?: number;
  /** Optional free-form description. */
  description?: string;
}

/**
 * Validate that a value is a finite number suitable for formatting.
 * Rejects NaN, Infinity, and non-numeric inputs.
 */
function assertFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

/**
 * Clamp a requested fraction-digit count into a safe, bounded range.
 */
function clampFractionDigits(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.trunc(value), 0), MAX_FRACTION_DIGITS);
}

/**
 * Guard against unexpectedly large rendered output.
 */
function boundOutput(output: string): string {
  return output.length > MAX_OUTPUT_LENGTH ? output.slice(0, MAX_OUTPUT_LENGTH) : output;
}

/**
 * Format a monetary amount for the given locale and currency.
 *
 * @param amount   Authoritative numeric amount (may be negative).
 * @param locale   BCP 47 locale tag; defaults to en-US.
 * @param currency ISO 4217 currency code; defaults to USD.
 * @param options  Optional fraction-digit overrides.
 */
export function formatMoney(
  amount: number,
  locale: string = DEFAULT_LOCALE,
  currency: string = DEFAULT_CURRENCY,
  options: { minimumFractionDigits?: number; maximumFractionDigits?: number } = {},
): string {
  const value = assertFiniteNumber(amount, 'amount');
  const minimumFractionDigits = clampFractionDigits(options.minimumFractionDigits, 2);
  const maximumFractionDigits = clampFractionDigits(
    options.maximumFractionDigits,
    Math.max(minimumFractionDigits, 2),
  );

  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits,
    maximumFractionDigits: Math.max(minimumFractionDigits, maximumFractionDigits),
  });

  return boundOutput(formatter.format(value));
}

/**
 * Format a ledger amount with an explicit debit/credit sign.
 *
 * The magnitude is formatted as currency and prefixed with a locale-aware
 * sign so debits and credits remain unambiguous regardless of locale
 * conventions for negative numbers.
 */
export function formatLedgerAmount(
  amount: number,
  direction: 'debit' | 'credit',
  locale: string = DEFAULT_LOCALE,
  currency: string = DEFAULT_CURRENCY,
): string {
  const magnitude = Math.abs(assertFiniteNumber(amount, 'amount'));
  if (direction !== 'debit' && direction !== 'credit') {
    throw new TypeError('direction must be "debit" or "credit"');
  }
  const formatted = formatMoney(magnitude, locale, currency);
  const sign = direction === 'debit' ? '-' : '+';
  return boundOutput(`${sign}${formatted}`);
}

/**
 * Format a ledger timestamp for the given locale.
 */
export function formatLedgerDate(
  timestamp: string | number | Date,
  locale: string = DEFAULT_LOCALE,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' },
): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError('timestamp must be a valid date');
  }
  const formatter = new Intl.DateTimeFormat(locale, options);
  return boundOutput(formatter.format(date));
}

/**
 * Format a complete ledger entry into a display-ready record.
 *
 * The running balance is derived from the authoritative `balance` field when
 * present; no arithmetic is performed on amounts here.
 */
export function formatLedgerEntry(
  entry: LedgerEntry,
  locale: string = DEFAULT_LOCALE,
  currency: string = DEFAULT_CURRENCY,
): { date: string; amount: string; balance: string | null; description: string | null } {
  if (entry === null || typeof entry !== 'object') {
    throw new TypeError('entry must be an object');
  }

  const date = formatLedgerDate(entry.timestamp, locale);
  const amount = formatLedgerAmount(entry.amount, entry.direction, locale, currency);
  const balance =
    entry.balance === undefined ? null : formatMoney(entry.balance, locale, currency);
  const description =
    typeof entry.description === 'string' && entry.description.length > 0
      ? entry.description.slice(0, MAX_OUTPUT_LENGTH)
      : null;

  return { date, amount, balance, description };
}
