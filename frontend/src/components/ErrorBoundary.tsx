import React from 'react';

/**
 * Schema-driven presentation for API error codes.
 *
 * The mapping is intentionally data-only so it can be validated, tested and
 * extended without touching rendering logic. Unknown or malformed payloads
 * always resolve to a safe fallback presentation.
 */
export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

export type ErrorAction = 'retry' | 'reauth' | 'contact_support' | 'none';

export interface ErrorPresentation {
  code: string;
  message: string;
  severity: ErrorSeverity;
  retryable: boolean;
  action: ErrorAction;
}

interface ErrorSchemaEntry {
  message: string;
  severity: ErrorSeverity;
  retryable: boolean;
  action: ErrorAction;
}

/**
 * Authoritative mapping of deployed API error codes to presentation metadata.
 * Codes are matched case-insensitively. Keep this in sync with the backend
 * error contract; unknown codes fall back to FALLBACK_PRESENTATION.
 */
export const ERROR_SCHEMA: Readonly<Record<string, ErrorSchemaEntry>> = Object.freeze({
  UNAUTHORIZED: {
    message: 'Your session has expired. Please sign in again.',
    severity: 'warning',
    retryable: false,
    action: 'reauth',
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
    action: 'none',
  },
  VALIDATION_ERROR: {
    message: 'Some of the provided values are invalid. Please review and try again.',
    severity: 'warning',
    retryable: false,
    action: 'none',
  },
  RATE_LIMITED: {
    message: 'Too many requests. Please wait a moment and try again.',
    severity: 'warning',
    retryable: true,
    action: 'retry',
  },
  CONFLICT: {
    message: 'This action conflicts with the current state. Refresh and try again.',
    severity: 'warning',
    retryable: true,
    action: 'retry',
  },
  STALE_DATA: {
    message: 'The data you are viewing is out of date. Refresh to continue.',
    severity: 'info',
    retryable: true,
    action: 'retry',
  },
  DEPENDENCY_FAILURE: {
    message: 'A required service is temporarily unavailable. Please try again shortly.',
    severity: 'error',
    retryable: true,
    action: 'retry',
  },
  INTERNAL_ERROR: {
    message: 'Something went wrong on our end. Please try again.',
    severity: 'critical',
    retryable: true,
    action: 'retry',
  },
  NETWORK_ERROR: {
    message: 'Network unavailable. Check your connection and try again.',
    severity: 'error',
    retryable: true,
    action: 'retry',
  },
});

export const FALLBACK_PRESENTATION: ErrorPresentation = Object.freeze({
  code: 'UNKNOWN_ERROR',
  message: 'An unexpected error occurred. Please try again.',
  severity: 'error',
  retryable: true,
  action: 'retry',
});

const MAX_CODE_LENGTH = 64;
const CODE_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Validate a raw error code. Returns a normalized (upper-case) code or null
 * when the value is missing, malformed, or unreasonably long.
 */
export function normalizeErrorCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_CODE_LENGTH) return null;
  if (!CODE_PATTERN.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

/**
 * Resolve a presentation for an API error code. Unknown or malformed codes
 * resolve to the safe fallback so the UI never renders an empty message.
 */
export function resolveErrorPresentation(rawCode: unknown): ErrorPresentation {
  const code = normalizeErrorCode(rawCode);
  if (!code) return FALLBACK_PRESENTATION;

  const entry = ERROR_SCHEMA[code];
  if (!entry) {
    return { ...FALLBACK_PRESENTATION, code };
  }

  return {
    code,
    message: entry.message,
    severity: entry.severity,
    retryable: entry.retryable,
    action: entry.action,
  };
}

/**
 * Extract an error code from a variety of API error payload shapes while
 * preserving compatibility with existing deployed contracts.
 */
export function extractErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as Record<string, unknown>;

  const direct = normalizeErrorCode(candidate.code);
  if (direct) return direct;

  const response = candidate.response;
  if (response && typeof response === 'object') {
    const data = (response as Record<string, unknown>).data;
    if (data && typeof data === 'object') {
      const nested = normalizeErrorCode((data as Record<string, unknown>).code);
      if (nested) return nested;
    }
  }

  return null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: (presentation: ErrorPresentation, reset: () => void) => React.ReactNode;
}

interface ErrorBoundaryState {
  presentation: ErrorPresentation | null;
}

/**
 * Error boundary that renders schema-driven presentation for API error codes.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { presentation: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    const code = extractErrorCode(error);
    return { presentation: resolveErrorPresentation(code) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const presentation = this.state.presentation ?? FALLBACK_PRESENTATION;
    // Structured diagnostic for observability; never throws.
    try {
      // eslint-disable-next-line no-console
      console.error('[ErrorBoundary]', {
        code: presentation.code,
        severity: presentation.severity,
        retryable: presentation.retryable,
        action: presentation.action,
        componentStack: info?.componentStack,
        error,
      });
    } catch {
      /* diagnostics must never mask the original error */
    }
  }

  reset = (): void => {
    this.setState({ presentation: null });
  };

  render(): React.ReactNode {
    const { presentation } = this.state;
    if (!presentation) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback(presentation, this.reset);
    }

    return (
      <div role="alert" data-severity={presentation.severity} data-error-code={presentation.code}>
        <p>{presentation.message}</p>
        {presentation.retryable && (
          <button type="button" onClick={this.reset}>
            Try again
          </button>
        )}
      </div>
    );
  }
}

export default ErrorBoundary;
