import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';

/**
 * Schema-driven presentation for API error codes.
 *
 * The backend error contract is preserved: responses still carry a machine
 * readable `code` (and optional `message`/`details`). This module maps those
 * codes to presentation metadata (message, severity, retryability, action) so
 * UI consumers render consistent, actionable errors without hard-coding
 * strings at each call site.
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
 * Authoritative mapping of known API error codes to presentation metadata.
 * Unknown codes fall back to a safe, non-retryable presentation.
 */
const ERROR_SCHEMA: Record<string, ErrorSchemaEntry> = {
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
    message: 'Some of the provided information is invalid.',
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
    message: 'This data is out of date. Refresh to see the latest.',
    severity: 'info',
    retryable: true,
    action: 'retry',
  },
  DEPENDENCY_FAILURE: {
    message: 'A required service is temporarily unavailable. Please try again.',
    severity: 'error',
    retryable: true,
    action: 'retry',
  },
  INTERNAL_ERROR: {
    message: 'Something went wrong on our end. Please try again later.',
    severity: 'critical',
    retryable: true,
    action: 'contact_support',
  },
};

const FALLBACK_PRESENTATION: ErrorPresentation = {
  code: 'UNKNOWN_ERROR',
  message: 'An unexpected error occurred. Please try again.',
  severity: 'error',
  retryable: false,
  action: 'contact_support',
};

/**
 * Extract a normalized error code from an arbitrary API error payload.
 * Returns null when the payload is malformed or missing a usable code.
 */
export function extractErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const candidate = error as { code?: unknown; response?: { data?: unknown } };

  if (typeof candidate.code === 'string' && candidate.code.trim().length > 0) {
    return candidate.code.trim();
  }

  const data = candidate.response?.data;
  if (data && typeof data === 'object') {
    const dataCode = (data as { code?: unknown }).code;
    if (typeof dataCode === 'string' && dataCode.trim().length > 0) {
      return dataCode.trim();
    }
  }

  return null;
}

/**
 * Resolve presentation metadata for an API error.
 *
 * Unknown or malformed payloads resolve to a safe fallback so the UI never
 * renders an empty or misleading error state.
 */
export function presentApiError(error: unknown): ErrorPresentation {
  const code = extractErrorCode(error);

  if (!code) {
    return { ...FALLBACK_PRESENTATION };
  }

  const entry = ERROR_SCHEMA[code];
  if (!entry) {
    return { ...FALLBACK_PRESENTATION, code };
  }

  return { code, ...entry };
}

/**
 * Whether an error is safe to retry based on its presentation metadata.
 */
export function isRetryableError(error: unknown): boolean {
  return presentApiError(error).retryable;
}

const api: AxiosInstance = axios.create({
  baseURL: process.env.REACT_APP_API_BASE_URL || '/api',
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config: AxiosRequestConfig) => {
  const token = localStorage.getItem('auth_token');
  if (token && config.headers) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    const presentation = presentApiError(error);

    if (presentation.action === 'reauth') {
      localStorage.removeItem('auth_token');
    }

    return Promise.reject(error);
  }
);

export default api;
