import { EventSourcePolyfill } from 'event-source-polyfill';

export type NotificationEvent = {
  id?: string;
  type: string;
  payload: unknown;
  receivedAt: string;
};

export type NotificationHandler = (event: NotificationEvent) => void;

export type NotificationErrorHandler = (error: NotificationError) => void;

export type NotificationError = {
  kind: 'authorization' | 'network' | 'server' | 'unknown';
  status?: number;
  message: string;
  retryable: boolean;
};

export type NotificationServiceOptions = {
  url: string;
  token?: string;
  withCredentials?: boolean;
  /** Base delay in ms for exponential backoff. Defaults to 1000. */
  baseRetryDelayMs?: number;
  /** Maximum delay in ms between reconnection attempts. Defaults to 30000. */
  maxRetryDelayMs?: number;
  /** Maximum number of consecutive reconnection attempts. Defaults to Infinity. */
  maxRetries?: number;
};

const LAST_EVENT_ID_STORAGE_PREFIX = 'sse:lastEventId:';

/**
 * Stateful SSE notification client.
 *
 * Tracks the last received event id (cursor) and replays it on reconnect via
 * the `Last-Event-ID` header (and `lastEventId` query param fallback) so that
 * notifications missed during a disconnect are not lost. The cursor is also
 * persisted to sessionStorage so a page reload resumes from the same point.
 *
 * Authorization failures (401/403) stop reconnection and surface a structured
 * error instead of looping.
 */
export class NotificationService {
  private readonly url: string;
  private readonly token?: string;
  private readonly withCredentials: boolean;
  private readonly baseRetryDelayMs: number;
  private readonly maxRetryDelayMs: number;
  private readonly maxRetries: number;
  private readonly storageKey: string;

  private source: EventSourcePolyfill | null = null;
  private handlers = new Set<NotificationHandler>();
  private errorHandlers = new Set<NotificationErrorHandler>();
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastEventId: string | null = null;

  constructor(options: NotificationServiceOptions) {
    this.url = options.url;
    this.token = options.token;
    this.withCredentials = options.withCredentials ?? false;
    this.baseRetryDelayMs = options.baseRetryDelayMs ?? 1000;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 30000;
    this.maxRetries = options.maxRetries ?? Infinity;
    this.storageKey = `${LAST_EVENT_ID_STORAGE_PREFIX}${options.url}`;
    this.lastEventId = this.readPersistedCursor();
  }

  /** Current cursor used for reconnection. Exposed for diagnostics/tests. */
  getLastEventId(): string | null {
    return this.lastEventId;
  }

  onEvent(handler: NotificationHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onError(handler: NotificationErrorHandler): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  connect(): void {
    if (this.source || this.stopped) {
      return;
    }

    const headers: Record<string, string> = {};
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }
    if (this.lastEventId) {
      headers['Last-Event-ID'] = this.lastEventId;
    }

    const source = new EventSourcePolyfill(this.buildUrl(), {
      headers,
      withCredentials: this.withCredentials,
    });
    this.source = source;

    source.onopen = () => {
      this.retries = 0;
    };

    source.onmessage = (event: MessageEvent) => {
      this.handleMessage(event);
    };

    source.onerror = (event: Event) => {
      this.handleError(event);
    };
  }

  disconnect(): void {
    this.stopped = true;
    this.clearRetryTimer();
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }

  private buildUrl(): string {
    if (!this.lastEventId) {
      return this.url;
    }
    const separator = this.url.includes('?') ? '&' : '?';
    return `${this.url}${separator}lastEventId=${encodeURIComponent(this.lastEventId)}`;
  }

  private handleMessage(event: MessageEvent): void {
    const id = (event as MessageEvent & { lastEventId?: string }).lastEventId;
    if (id) {
      this.lastEventId = id;
      this.persistCursor(id);
    }

    let payload: unknown = event.data;
    try {
      payload = JSON.parse(event.data);
    } catch {
      // Preserve raw payload when it is not JSON.
    }

    const notification: NotificationEvent = {
      id: id || undefined,
      type: (event as MessageEvent & { type?: string }).type ?? 'message',
      payload,
      receivedAt: new Date().toISOString(),
    };

    this.handlers.forEach((handler) => handler(notification));
  }

  private handleError(event: Event): void {
    const status = this.extractStatus(event);

    if (status === 401 || status === 403) {
      this.emitError({
        kind: 'authorization',
        status,
        message: 'SSE authorization failed; reconnection stopped.',
        retryable: false,
      });
      this.disconnect();
      return;
    }

    this.emitError({
      kind: status && status >= 500 ? 'server' : 'network',
      status,
      message: 'SSE connection error; scheduling reconnect.',
      retryable: true,
    });

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) {
      return;
    }
    if (this.retries >= this.maxRetries) {
      this.emitError({
        kind: 'network',
        message: 'SSE max retries reached; giving up.',
        retryable: false,
      });
      this.disconnect();
      return;
    }

    const delay = Math.min(
      this.baseRetryDelayMs * 2 ** this.retries,
      this.maxRetryDelayMs,
    );
    this.retries += 1;

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.source) {
        this.source.close();
        this.source = null;
      }
      this.connect();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private emitError(error: NotificationError): void {
    this.errorHandlers.forEach((handler) => handler(error));
  }

  private extractStatus(event: Event): number | undefined {
    const candidate = event as Event & { status?: number };
    return typeof candidate.status === 'number' ? candidate.status : undefined;
  }

  private readPersistedCursor(): string | null {
    try {
      return sessionStorage.getItem(this.storageKey);
    } catch {
      return null;
    }
  }

  private persistCursor(id: string): void {
    try {
      sessionStorage.setItem(this.storageKey, id);
    } catch {
      // Storage may be unavailable (private mode); cursor stays in memory.
    }
  }
}
