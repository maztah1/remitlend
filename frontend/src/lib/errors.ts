/**
 * Schema-driven error presentation for API error codes.
 *
 * Maps backend error codes to user-facing presentation metadata
 * (message, severity, retryability, action). Unknown or malformed
 * payloads fall back to a safe generic presentation so the UI never
 * renders raw/untrusted server text.
 */

export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

export type ErrorAction =
  | 'retry'
  | 'reauthenticate'
  | 'contact_support'
  | 'refresh'
  | 'none';

export interface ErrorPresentation {
  /** Stable machine code, or 'UNKNOWN' when the payload is unrecognized. */
  code: string;
  /** Safe, user-facing message. Never derived from raw server text. */
  message: string;
  severity: ErrorSeverity;
  /** Whether the caller may safely retry the failed operation. */
  retryable: boolean;
  action: ErrorAction;
  /** Optional suggested backoff in milliseconds for retryable errors. */
  retryAfterMs?: number;
}

interface ErrorSchemaEntry {
  message: string;
  severity: ErrorSeverity;
  retryable: boolean;
  action: ErrorAction;
  retryAfterMs?: number;
}

/**
 * Schema of known API error codes. Extend here as the backend contract grows;
 * unknown codes degrade gracefully via the fallback below.
 */
const ERROR_SCHEMA: Record<string, ErrorSchemaEntry> = {
  UNAUTHORIZED: {
    message: 'Your session has expired. Please sign in again.',
    severity: 'warning',
    retryable: false,
    action: 'reauthenticate',
  },
  FORBIDDEN: {
    message: 'You do not have permission to perform this action.',
    severity: 'error',
    retryable: false,
    action: 'contact_support',
  },
  NOT_FOUND: {
    message: 'The requested resource could not be found.',
    severity: 'warning',
    retryable: false,
    action: 'refresh',
  },
  VALIDATION_ERROR: {
    message: 'Some of the provided information is invalid. Please review and try again.',
    severity: 'warning',
    retryable: false,
    action: 'none',
  },
  RATE_LIMITED: {
    message: 'Too many requests. Please wait a moment and try again.',
    severity: 'warning',
    retryable: true,
    action: 'retry',
    retryAfterMs: 5000,
  },
  CONFLICT: {
    message: 'This action conflicts with the current state. Refresh and try again.',
    severity: 'warning',
    retryable: true,
    action: 'refresh',
    retryAfterMs: 1000,
  },
  STALE_DATA: {
    message: 'The data you are viewing is out of date. Refresh to see the latest.',
    severity: 'info',
    retryable: true,
    action: 'refresh',
    retryAfterMs: 0,
  },
  DEPENDENCY_UNAVAILABLE: {
    message: 'A required service is temporarily unavailable. Please try again shortly.',
    severity: 'error',
    retryable: true,
    action: 'retry',
    retryAfterMs: 10000,
  },
  TIMEOUT: {
    message: 'The request timed out. Please try again.',
    severity: 'error',
    retryable: true,
    action: 'retry',
    retryAfterMs: 2000,
  },
  INTERNAL_ERROR: {
    message: 'Something went wrong on our end. Please try again later.',
    severity: 'critical',
    retryable: true,
    action: 'contact_support',
    retryAfterMs: 15000,
  },
};

const FALLBACK: ErrorPresentation = {
  code: 'UNKNOWN',
  message: 'An unexpected error occurred. Please try again.',
  severity: 'error',
  retryable: false,
  action: 'none',
};

const MAX_CODE_LENGTH = 64;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * Extract a candidate error code from an unknown API payload.
 * Accepts a bare string code or an object with a `code` field.
 * Returns null when the payload is malformed or the code is unsafe.
 */
export function extractErrorCode(payload: unknown): string | null {
  let raw: unknown;
  if (typeof payload === 'string') {
    raw = payload;
  } else if (payload && typeof payload === 'object') {
    raw = (payload as { code?: unknown }).code;
  } else {
    return null;
  }

  if (typeof raw !== 'string') return null;
  const code = raw.trim();
  if (code.length === 0 || code.length > MAX_CODE_LENGTH) return null;
  if (!CODE_PATTERN.test(code)) return null;
  return code;
}

/**
 * Resolve an API error payload into a safe presentation object.
 * Unknown or malformed payloads return the fallback presentation.
 */
export function presentError(payload: unknown): ErrorPresentation {
  const code = extractErrorCode(payload);
  if (!code) return { ...FALLBACK };

  const entry = ERROR_SCHEMA[code];
  if (!entry) {
    return { ...FALLBACK, code };
  }

  return {
    code,
    message: entry.message,
    severity: entry.severity,
    retryable: entry.retryable,
    action: entry.action,
    ...(entry.retryAfterMs !== undefined ? { retryAfterMs: entry.retryAfterMs } : {}),
  };
}

/**
 * Compute the next retry delay for a presentation, honoring the schema's
 * suggested backoff and applying bounded exponential growth per attempt.
 * Returns null when the error is not retryable.
 */
export function nextRetryDelayMs(
  presentation: ErrorPresentation,
  attempt: number,
  maxDelayMs = 30000,
): number | null {
  if (!presentation.retryable) return null;
  const base = presentation.retryAfterMs ?? 1000;
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 1;
  const delay = base * Math.pow(2, safeAttempt - 1);
  return Math.min(delay, maxDelayMs);
}

/**
 * Whether a presentation indicates the caller must re-authenticate before
 * any further requests will succeed.
 */
export function requiresReauthentication(presentation: ErrorPresentation): boolean {
  return presentation.action === 'reauthenticate';
}
