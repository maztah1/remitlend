/**
 * Secure deep-link handling for transaction status.
 *
 * Frontend-only module. It parses and validates transaction-status deep links
 * (e.g. `app://tx/0xabc...?chain=1`) before any network access, then resolves
 * the status from the authoritative backend endpoint with bounded retries and
 * timeouts. No contract or API shape is changed; the resolver only reads the
 * existing status endpoint.
 */

/** Allowed route segments for a transaction-status deep link. */
export const ALLOWED_TX_ROUTES = ['tx', 'transaction'] as const;
export type TxRoute = (typeof ALLOWED_TX_ROUTES)[number];

/** Supported chain ids. Kept in sync with deployed contracts. */
export const SUPPORTED_CHAIN_IDS = [1, 5, 10, 137, 42161] as const;
export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

/** Canonical transaction status values returned by the backend. */
export type TransactionStatus =
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'dropped';

export interface ParsedTxDeepLink {
  route: TxRoute;
  hash: string;
  chainId: SupportedChainId;
}

export interface TxStatusResult {
  hash: string;
  chainId: SupportedChainId;
  status: TransactionStatus;
  /** Block number when confirmed, otherwise null. */
  blockNumber: number | null;
  /** True when the value came from a cached/stale response. */
  stale: boolean;
  /** ISO timestamp of when the status was observed. */
  observedAt: string;
}

/** Structured error codes for observability and UI mapping. */
export type TxStatusErrorCode =
  | 'INVALID_LINK'
  | 'UNSUPPORTED_ROUTE'
  | 'INVALID_HASH'
  | 'UNSUPPORTED_CHAIN'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'TIMEOUT'
  | 'DEPENDENCY_FAILURE';

export class TxStatusError extends Error {
  readonly code: TxStatusErrorCode;
  readonly retryable: boolean;

  constructor(code: TxStatusErrorCode, message: string, retryable = false) {
    super(message);
    this.name = 'TxStatusError';
    this.code = code;
    this.retryable = retryable;
  }
}

/** Bounded resource limits for status resolution. */
export interface TxStatusLimits {
  /** Per-request timeout in milliseconds. */
  requestTimeoutMs: number;
  /** Maximum number of retry attempts after the first failure. */
  maxRetries: number;
  /** Base backoff in milliseconds (exponential). */
  baseBackoffMs: number;
  /** Maximum backoff in milliseconds. */
  maxBackoffMs: number;
  /** How long a cached status may be served before it is considered stale. */
  staleAfterMs: number;
}

export const DEFAULT_TX_STATUS_LIMITS: TxStatusLimits = {
  requestTimeoutMs: 8000,
  maxRetries: 3,
  baseBackoffMs: 250,
  maxBackoffMs: 4000,
  staleAfterMs: 30000,
};

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * Parse and validate a transaction-status deep link.
 *
 * Accepts absolute (`app://tx/0x..?chain=1`) or path-style (`/tx/0x..?chain=1`)
 * links. Validation is strict and happens before any network access:
 *  - route must be in the allowlist
 *  - hash must be a 32-byte hex string
 *  - chain id must be a supported integer
 *
 * Throws {@link TxStatusError} with a structured code on any invalid input.
 */
export function parseTxDeepLink(rawLink: string): ParsedTxDeepLink {
  if (typeof rawLink !== 'string' || rawLink.trim() === '') {
    throw new TxStatusError('INVALID_LINK', 'Deep link is empty.');
  }

  let url: URL;
  try {
    // Normalize path-style links into an absolute URL so URL parsing is uniform.
    const normalized = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawLink)
      ? rawLink
      : `app://${rawLink.replace(/^\/+/, '')}`;
    url = new URL(normalized);
  } catch {
    throw new TxStatusError('INVALID_LINK', 'Deep link is not a valid URL.');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const route = segments[0];
  const hash = segments[1];

  if (!route || !(ALLOWED_TX_ROUTES as readonly string[]).includes(route)) {
    throw new TxStatusError(
      'UNSUPPORTED_ROUTE',
      `Route "${route ?? ''}" is not an allowed transaction route.`,
    );
  }

  if (!hash || !HASH_RE.test(hash)) {
    throw new TxStatusError(
      'INVALID_HASH',
      'Transaction hash must be a 0x-prefixed 32-byte hex string.',
    );
  }

  const chainParam = url.searchParams.get('chain');
  const chainId = Number(chainParam);
  if (
    chainParam === null ||
    !Number.isInteger(chainId) ||
    !(SUPPORTED_CHAIN_IDS as readonly number[]).includes(chainId)
  ) {
    throw new TxStatusError(
      'UNSUPPORTED_CHAIN',
      `Chain id "${chainParam ?? ''}" is not supported.`,
    );
  }

  return {
    route: route as TxRoute,
    hash: hash.toLowerCase(),
    chainId: chainId as SupportedChainId,
  };
}

/** Minimal fetch surface so the resolver is testable without a real network. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface TxStatusResolverOptions {
  /** Base URL of the existing status API. No shape change to the endpoint. */
  baseUrl: string;
  /** Optional bearer token; absence yields UNAUTHORIZED on 401/403. */
  getAuthToken?: () => string | null | undefined;
  fetchImpl?: FetchLike;
  limits?: Partial<TxStatusLimits>;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable sleep for deterministic backoff in tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional structured logger for observability. */
  onEvent?: (event: TxStatusEvent) => void;
}

export interface TxStatusEvent {
  name: 'tx_status_resolved' | 'tx_status_retry' | 'tx_status_failed';
  hash: string;
  chainId: SupportedChainId;
  code?: TxStatusErrorCode;
  attempt?: number;
  stale?: boolean;
  durationMs?: number;
}

interface CacheEntry {
  result: TxStatusResult;
  storedAt: number;
}

const STATUS_VALUES: readonly TransactionStatus[] = [
  'pending',
  'confirmed',
  'failed',
  'dropped',
];

function isTransactionStatus(value: unknown): value is TransactionStatus {
  return typeof value === 'string' && (STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * Resolves transaction status from the authoritative backend with bounded
 * retries, per-request timeouts, and stale-cache fallback.
 *
 * Behavior:
 *  - 401/403 -> UNAUTHORIZED (not retried)
 *  - 404     -> NOT_FOUND (not retried)
 *  - 5xx / network / timeout -> retried up to `maxRetries` with exponential
 *    backoff, then DEPENDENCY_FAILURE (or TIMEOUT for the last timeout).
 *  - On terminal failure, a previously cached value is served with
 *    `stale: true` when available; otherwise the error is thrown.
 */
export class TransactionStatusResolver {
  private readonly baseUrl: string;
  private readonly getAuthToken: () => string | null | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly limits: TxStatusLimits;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onEvent?: (event: TxStatusEvent) => void;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: TxStatusResolverOptions) {
    if (!options.baseUrl) {
      throw new TxStatusError('INVALID_LINK', 'baseUrl is required.');
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.getAuthToken = options.getAuthToken ?? (() => null);
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.limits = { ...DEFAULT_TX_STATUS_LIMITS, ...options.limits };
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onEvent = options.onEvent;
  }

  /** Resolve status for a validated deep link. */
  async resolveFromLink(rawLink: string): Promise<TxStatusResult> {
    const parsed = parseTxDeepLink(rawLink);
    return this.resolve(parsed.hash, parsed.chainId);
  }

  /** Resolve status for an already-validated hash + chain. */
  async resolve(hash: string, chainId: SupportedChainId): Promise<TxStatusResult> {
    if (!HASH_RE.test(hash)) {
      throw new TxStatusError('INVALID_HASH', 'Invalid transaction hash.');
    }
    const key = `${chainId}:${hash.toLowerCase()}`;
    const startedAt = this.now();
    let lastError: TxStatusError | null = null;

    for (let attempt = 0; attempt <= this.limits.maxRetries; attempt += 1) {
      try {
        const result = await this.fetchOnce(hash, chainId);
        this.cache.set(key, { result, storedAt: this.now() });
        this.emit({
          name: 'tx_status_resolved',
          hash,
          chainId,
          stale: false,
          durationMs: this.now() - startedAt,
        });
        return result;
      } catch (err) {
        const error = err instanceof TxStatusError
          ? err
          : new TxStatusError('DEPENDENCY_FAILURE', 'Unexpected status error.', true);
        lastError = error;

        if (!error.retryable || attempt === this.limits.maxRetries) {
          break;
        }

        const backoff = Math.min(
          this.limits.baseBackoffMs * 2 ** attempt,
          this.limits.maxBackoffMs,
        );
        this.emit({
          name: 'tx_status_retry',
          hash,
          chainId,
          code: error.code,
          attempt: attempt + 1,
        });
        await this.sleep(backoff);
      }
    }

    const cached = this.cache.get(key);
    if (cached) {
      const stale = this.now() - cached.storedAt > this.limits.staleAfterMs;
      const result: TxStatusResult = { ...cached.result, stale: true };
      this.emit({
        name: 'tx_status_resolved',
        hash,
        chainId,
        code: lastError?.code,
        stale,
        durationMs: this.now() - startedAt,
      });
      return result;
    }

    const finalError = lastError ?? new TxStatusError('DEPENDENCY_FAILURE', 'Status unavailable.', true);
    this.emit({
      name: 'tx_status_failed',
      hash,
      chainId,
      code: finalError.code,
      durationMs: this.now() - startedAt,
    });
    throw finalError;
  }

  private async fetchOnce(hash: string, chainId: SupportedChainId): Promise<TxStatusResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.limits.requestTimeoutMs);
    const token = this.getAuthToken();
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    try {
      const response = await this.fetchImpl(
        `${this.baseUrl}/transactions/${chainId}/${hash}`,
        { signal: controller.signal, headers },
      );

      if (response.status === 401 || response.status === 403) {
        throw new TxStatusError('UNAUTHORIZED', 'Not authorized to read transaction status.');
      }
      if (response.status === 404) {
        throw new TxStatusError('NOT_FOUND', 'Transaction not found.');
      }
      if (!response.ok) {
        throw new TxStatusError(
          'DEPENDENCY_FAILURE',
          `Status endpoint returned ${response.status}.`,
          true,
        );
      }

      const body = (await response.json()) as Record<string, unknown>;
      if (!isTransactionStatus(body?.status)) {
        throw new TxStatusError(
          'DEPENDENCY_FAILURE',
          'Malformed status payload.',
          true,
        );
      }

      const blockNumber =
        typeof body.blockNumber === 'number' && Number.isFinite(body.blockNumber)
          ? body.blockNumber
          : null;

      return {
        hash: hash.toLowerCase(),
        chainId,
        status: body.status,
        blockNumber,
        stale: false,
        observedAt: new Date(this.now()).toISOString(),
      };
    } catch (err) {
      if (err instanceof TxStatusError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new TxStatusError('TIMEOUT', 'Status request timed out.', true);
      }
      throw new TxStatusError('DEPENDENCY_FAILURE', 'Status request failed.', true);
    } finally {
      clearTimeout(timer);
    }
  }

  private emit(event: TxStatusEvent): void {
    if (this.onEvent) {
      this.onEvent(event);
    }
  }
}
