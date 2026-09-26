// Locale-aware money and ledger formatting utilities.
//
// These helpers are pure and side-effect free. They derive all user-visible
// values from authoritative numeric sources (minor units / ISO timestamps)
// and never mutate or reinterpret persisted data or wire formats.
//
// Compatibility: no backend schema or API contract is touched. Callers pass
// the same numeric amounts and ISO date strings they already receive.

/** Maximum number of characters a formatted value may occupy. */
export const MAX_FORMATTED_LENGTH = 64;

/** Maximum number of fraction digits we will ever render. */
export const MAX_FRACTION_DIGITS = 8;

/** Default locale used when the caller does not supply one. */
export const DEFAULT_LOCALE = 'en-US';

/**
 * A single ledger entry as consumed by the formatters. Amounts are expressed
 * in minor units (e.g. cents) to avoid floating point drift; `currency` is an
 * ISO 4217 code. `direction` is derived from the authoritative sign.
 */
export interface LedgerEntry {
  /** Stable identifier for the entry. */
  id: string;
  /** ISO 8601 timestamp of when the entry was recorded. */
  timestamp: string;
  /** Amount in minor units (integer). Sign encodes debit/credit. */
  amountMinor: number;
  /** ISO 4217 currency code, e.g. "USD". */
  currency: string;
  /** Optional running balance in minor units after this entry. */
  balanceMinor?: number;
  /** Optional human-readable description. */
  description?: string;
}

/** Options shared by the money and ledger formatters. */
export interface FormatOptions {
  /** BCP 47 locale tag. Defaults to {@link DEFAULT_LOCALE}. */
  locale?: string;
  /** Override the number of fraction digits (bounded by MAX_FRACTION_DIGITS). */
  fractionDigits?: number;
}

/** Result of formatting a ledger entry, ready for rendering. */
export interface FormattedLedgerEntry {
  id: string;
  /** Localized date/time string, or the raw timestamp if unparseable. */
  date: string;
  /** Localized signed amount, e.g. "-$12.34". */
  amount: string;
  /** Localized running balance, or null when unavailable. */
  balance: string | null;
  /** "debit" | "credit" | "zero" derived from the authoritative sign. */
  direction: 'debit' | 'credit' | 'zero';
  description: string;
}

/**
 * Clamp a requested fraction-digit count into the supported range.
 * Non-finite or missing values fall back to the currency default (2).
 */
function clampFractionDigits(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 2;
  }
  const floored = Math.trunc(value);
  if (floored < 0) {
    return 0;
  }
  return Math.min(floored, MAX_FRACTION_DIGITS);
}

/**
 * Validate a locale tag. Falls back to {@link DEFAULT_LOCALE} for empty or
 * malformed tags so a bad caller value can never throw at render time.
 */
function safeLocale(locale: string | undefined): string {
  if (typeof locale !== 'string' || locale.trim() === '') {
    return DEFAULT_LOCALE;
  }
  try {
    // Throws RangeError for structurally invalid tags.
    return Intl.NumberFormat.supportedLocalesOf([locale]).length > 0
      ? locale
      : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

/**
 * Validate an ISO 4217 currency code. Falls back to "USD" when the code is
 * missing or not recognized by the runtime, keeping rendering total.
 */
function safeCurrency(currency: string | undefined): string {
  if (typeof currency !== 'string' || !/^[A-Za-z]{3}$/.test(currency)) {
    return 'USD';
  }
  const upper = currency.toUpperCase();
  try {
    // Throws RangeError for unknown currency codes.
    new Intl.NumberFormat(DEFAULT_LOCALE, { style: 'currency', currency: upper });
    return upper;
  } catch {
    return 'USD';
  }
}

/**
 * Truncate a formatted string to the bounded maximum length. Guards against
 * pathological locales producing unbounded output.
 */
function bound(value: string): string {
  return value.length > MAX_FORMATTED_LENGTH
    ? value.slice(0, MAX_FORMATTED_LENGTH)
    : value;
}

/**
 * Format an amount given in minor units as a locale-aware currency string.
 *
 * - Rejects non-finite / NaN amounts by returning an empty string.
 * - Uses Intl.NumberFormat with explicit locale and currency options so
 *   symbol placement, grouping, decimals and negative signs follow the locale.
 * - Precision is capped at {@link MAX_FRACTION_DIGITS} and output length at
 *   {@link MAX_FORMATTED_LENGTH}.
 */
export function formatMoney(
  amountMinor: number,
  currency: string,
  options: FormatOptions = {},
): string {
  if (typeof amountMinor !== 'number' || !Number.isFinite(amountMinor)) {
    return '';
  }
  const locale = safeLocale(options.locale);
  const code = safeCurrency(currency);
  const fractionDigits = clampFractionDigits(options.fractionDigits);
  const major = amountMinor / 100;
  try {
    const formatted = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(major);
    return bound(formatted);
  } catch {
    return '';
  }
}

/**
 * Format an ISO 8601 timestamp as a locale-aware date/time string. Returns the
 * raw input when it cannot be parsed so callers never lose the source value.
 */
export function formatLedgerDate(
  timestamp: string,
  options: FormatOptions = {},
): string {
  if (typeof timestamp !== 'string' || timestamp.trim() === '') {
    return '';
  }
  const locale = safeLocale(options.locale);
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return bound(timestamp);
  }
  try {
    return bound(
      new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(parsed),
    );
  } catch {
    return bound(timestamp);
  }
}

/**
 * Derive the debit/credit direction from the authoritative sign of the amount.
 */
export function ledgerDirection(amountMinor: number): 'debit' | 'credit' | 'zero' {
  if (typeof amountMinor !== 'number' || !Number.isFinite(amountMinor) || amountMinor === 0) {
    return 'zero';
  }
  return amountMinor < 0 ? 'debit' : 'credit';
}

/**
 * Format a full ledger entry for rendering. All displayed values are derived
 * from the authoritative numeric amount and ISO timestamp; nothing is mutated.
 */
export function formatLedgerEntry(
  entry: LedgerEntry,
  options: FormatOptions = {},
): FormattedLedgerEntry {
  const amount = formatMoney(entry.amountMinor, entry.currency, options);
  const balance =
    typeof entry.balanceMinor === 'number' && Number.isFinite(entry.balanceMinor)
      ? formatMoney(entry.balanceMinor, entry.currency, options)
      : null;
  return {
    id: entry.id,
    date: formatLedgerDate(entry.timestamp, options),
    amount,
    balance,
    direction: ledgerDirection(entry.amountMinor),
    description: typeof entry.description === 'string' ? entry.description : '',
  };
}
