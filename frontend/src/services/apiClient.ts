/**
 * API client with offline-aware read and action behavior.
 *
 * Reads: when the browser is offline (or a request fails due to a network
 * error), the client serves the last-known successful response from an
 * in-memory cache instead of fabricating data. Cached entries are tagged so
 * consumers can surface a "stale" status derived from the authoritative
 * response that was actually received.
 *
 * Actions: mutating requests are rejected while offline (or queued for
 * replay when connectivity returns) so we never optimistically mutate
 * financial or chain state that the backend has not confirmed.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface ApiRequestOptions {
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
  /** Bypass the read cache and always hit the network. */
  forceNetwork?: boolean;
  /** Abort signal forwarded to fetch. */
  signal?: AbortSignal;
}

export interface ApiResponse<T> {
  data: T;
  /** True when the payload was served from cache because the network was unavailable. */
  stale: boolean;
  /** Timestamp (ms) of the authoritative response the payload was derived from. */
  fetchedAt: number;
}

export class OfflineError extends Error {
  readonly code = 'OFFLINE';
  constructor(message = 'Action unavailable while offline') {
    super(message);
    this.name = 'OfflineError';
  }
}

interface CacheEntry {
  data: unknown;
  fetchedAt: number;
}

const READ_CACHE = new Map<string, CacheEntry>();

/** Pending mutating requests queued while offline, replayed on reconnect. */
interface QueuedAction {
  key: string;
  options: ApiRequestOptions;
  resolve: (value: ApiResponse<unknown>) => void;
  reject: (reason: unknown) => void;
}

const ACTION_QUEUE: QueuedAction[] = [];

function isBrowserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof OfflineError) return true;
  if (error instanceof TypeError) return true; // fetch rejects with TypeError on network failure
  return false;
}

function cacheKey(url: string, options: ApiRequestOptions): string {
  return `${options.method ?? 'GET'} ${url}`;
}

function readCache<T>(key: string): ApiResponse<T> | null {
  const entry = READ_CACHE.get(key);
  if (!entry) return null;
  return { data: entry.data as T, stale: true, fetchedAt: entry.fetchedAt };
}

async function performFetch<T>(url: string, options: ApiRequestOptions): Promise<ApiResponse<T>> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`);
  }

  const data = (await response.json()) as T;
  return { data, stale: false, fetchedAt: Date.now() };
}

/**
 * Perform an API request with offline-aware behavior.
 *
 * - GET requests fall back to the last-known cached response when offline or
 *   when the network fails, marked `stale: true`.
 * - Mutating requests are rejected with `OfflineError` while offline, or
 *   queued for replay when `queueWhenOffline` is enabled.
 */
export async function apiRequest<T>(
  url: string,
  options: ApiRequestOptions = {},
  queueWhenOffline = false,
): Promise<ApiResponse<T>> {
  const method = options.method ?? 'GET';
  const key = cacheKey(url, options);
  const isRead = method === 'GET';

  if (isBrowserOffline()) {
    if (isRead) {
      const cached = readCache<T>(key);
      if (cached) return cached;
      throw new OfflineError('No cached data available while offline');
    }
    if (queueWhenOffline) {
      return new Promise<ApiResponse<T>>((resolve, reject) => {
        ACTION_QUEUE.push({
          key,
          options,
          resolve: resolve as (value: ApiResponse<unknown>) => void,
          reject,
        });
      });
    }
    throw new OfflineError();
  }

  try {
    const result = await performFetch<T>(url, options);
    if (isRead) {
      READ_CACHE.set(key, { data: result.data, fetchedAt: result.fetchedAt });
    }
    return result;
  } catch (error) {
    if (isRead && !options.forceNetwork && isNetworkError(error)) {
      const cached = readCache<T>(key);
      if (cached) return cached;
    }
    throw error;
  }
}

/** Replay queued actions after connectivity is restored. */
export async function flushQueuedActions(): Promise<void> {
  if (isBrowserOffline()) return;
  const pending = ACTION_QUEUE.splice(0, ACTION_QUEUE.length);
  for (const action of pending) {
    try {
      const result = await performFetch(action.key.split(' ').slice(1).join(' '), action.options);
      action.resolve(result);
    } catch (error) {
      action.reject(error);
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    void flushQueuedActions();
  });
}
