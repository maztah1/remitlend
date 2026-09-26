import React from 'react';

/**
 * Locale-aware money and ledger formatting utilities.
 *
 * These helpers are intentionally dependency-free and derive all displayed
 * values from authoritative numeric sources (amounts, balances, timestamps).
 * They never mutate or reinterpret wire formats, so existing API consumers and
 * persisted data remain compatible.
 */

const MAX_STRING_LENGTH = 64;
const MAX_FRACTION_DIGITS = 8;

/**
 * Validate a numeric input for formatting. Rejects NaN, Infinity and values
 * whose string representation would exceed the bounded length.
 */
function assertFiniteNumber(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number`);
  }
  if (String(value).length > MAX_STRING_LENGTH) {
    throw new RangeError(`${label} exceeds maximum length of ${MAX_STRING_LENGTH}`);
  }
  return value;
}

function clampFractionDigits(digits: number): number {
  if (!Number.isFinite(digits)) {
    return 2;
  }
  return Math.min(Math.max(Math.trunc(digits), 0), MAX_FRACTION_DIGITS);
}

export interface MoneyFormatOptions {
  /** BCP 47 locale tag, e.g. "en-US", "de-DE". Defaults to the runtime locale. */
  locale?: string;
  /** ISO 4217 currency code, e.g. "USD", "EUR". Defaults to "USD". */
  currency?: string;
  /** Minimum fraction digits to display. */
  minimumFractionDigits?: number;
  /** Maximum fraction digits to display. */
  maximumFractionDigits?: number;
  /** Render the sign for positive values (e.g. "+1,234.00"). */
  signDisplay?: 'auto' | 'never' | 'always' | 'exceptZero';
}

/**
 * Format a monetary amount for the given locale and currency.
 * Handles currency symbol placement, grouping, decimals and negative values
 * via Intl.NumberFormat.
 */
export function formatMoney(amount: number, options: MoneyFormatOptions = {}): string {
  const value = assertFiniteNumber(amount, 'amount');
  const {
    locale,
    currency = 'USD',
    minimumFractionDigits = 2,
    maximumFractionDigits = 2,
    signDisplay = 'auto',
  } = options;

  const min = clampFractionDigits(minimumFractionDigits);
  const max = Math.max(min, clampFractionDigits(maximumFractionDigits));

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: min,
    maximumFractionDigits: max,
    signDisplay,
  }).format(value);
}

export interface LedgerEntry {
  id: string;
  /** Authoritative numeric amount; positive = credit, negative = debit. */
  amount: number;
  /** ISO 8601 timestamp or epoch milliseconds. */
  timestamp: string | number;
  /** Optional authoritative running balance after this entry. */
  balance?: number;
  description?: string;
}

export interface LedgerFormatOptions extends MoneyFormatOptions {
  /** Intl date/time style preset. Defaults to "medium". */
  dateStyle?: 'full' | 'long' | 'medium' | 'short';
  /** Intl time style preset. Defaults to "short". */
  timeStyle?: 'full' | 'long' | 'medium' | 'short';
}

export interface FormattedLedgerEntry {
  id: string;
  description: string;
  /** Locale-formatted date/time string. */
  date: string;
  /** Locale-formatted amount including currency. */
  amount: string;
  /** Locale-formatted running balance, when provided. */
  balance: string | null;
  /** "credit" | "debit" derived from the authoritative sign. */
  direction: 'credit' | 'debit';
}

function toDate(timestamp: string | number): Date {
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError('timestamp must be a valid date');
  }
  return date;
}

/**
 * Format a single ledger entry for display. All values are derived from the
 * authoritative numeric amount, balance and timestamp; nothing is inferred
 * from pre-formatted strings.
 */
export function formatLedgerEntry(
  entry: LedgerEntry,
  options: LedgerFormatOptions = {},
): FormattedLedgerEntry {
  const amount = assertFiniteNumber(entry.amount, 'amount');
  const { locale, dateStyle = 'medium', timeStyle = 'short', ...moneyOptions } = options;

  const date = new Intl.DateTimeFormat(locale, { dateStyle, timeStyle }).format(
    toDate(entry.timestamp),
  );

  const balance =
    entry.balance === undefined
      ? null
      : formatMoney(assertFiniteNumber(entry.balance, 'balance'), { locale, ...moneyOptions });

  return {
    id: entry.id,
    description: entry.description ?? '',
    date,
    amount: formatMoney(amount, { locale, ...moneyOptions }),
    balance,
    direction: amount < 0 ? 'debit' : 'credit',
  };
}

/**
 * Format a list of ledger entries. Bounded to avoid unbounded work on large
 * inputs; callers should paginate before passing more than `maxEntries`.
 */
export function formatLedger(
  entries: readonly LedgerEntry[],
  options: LedgerFormatOptions = {},
  maxEntries = 1000,
): FormattedLedgerEntry[] {
  if (!Array.isArray(entries)) {
    throw new TypeError('entries must be an array');
  }
  const limit = Math.min(Math.max(Math.trunc(maxEntries), 0), 10000);
  return entries.slice(0, limit).map((entry) => formatLedgerEntry(entry, options));
}

export interface LedgerTableProps {
  entries: readonly LedgerEntry[];
  locale?: string;
  currency?: string;
}

/**
 * Renders ledger entries using locale-aware money and date formatting.
 */
export function LedgerTable({ entries, locale, currency }: LedgerTableProps): JSX.Element {
  const rows = formatLedger(entries, { locale, currency });

  return (
    <table className="ledger-table">
      <thead>
        <tr>
          <th scope="col">Date</th>
          <th scope="col">Description</th>
          <th scope="col">Amount</th>
          <th scope="col">Balance</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id} data-direction={row.direction}>
            <td>{row.date}</td>
            <td>{row.description}</td>
            <td className={`amount amount--${row.direction}`}>{row.amount}</td>
            <td className="balance">{row.balance ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default LedgerTable;
