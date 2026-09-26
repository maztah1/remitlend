/**
 * Shared notification types for the frontend.
 *
 * These types describe the SSE notification contract consumed by the app.
 * The event payload shape and channel names are part of the deployed contract
 * and must remain backward compatible.
 */

export type NotificationChannel =
  | 'transactions'
  | 'system'
  | 'account';

export interface NotificationEvent {
  /**
   * Monotonic event id assigned by the server. Used as the SSE cursor so a
   * reconnecting client can resume without losing missed notifications.
   */
  id: string;
  channel: NotificationChannel;
  /** ISO-8601 timestamp of when the event was emitted. */
  timestamp: string;
  /** Opaque, channel-specific payload. Shape is preserved for consumers. */
  payload: Record<string, unknown>;
}

/**
 * Connection lifecycle for the SSE notification stream.
 *
 * `unauthorized` is terminal: reconnection must stop and the error surfaced
 * to the user rather than looping on 401/403 responses.
 */
export type NotificationConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'unauthorized'
  | 'error';

/**
 * Persisted reconnection cursor. Storing the last received event id lets the
 * client send `Last-Event-ID` (or the equivalent query param) on reconnect so
 * missed notifications are replayed instead of dropped.
 */
export interface NotificationCursor {
  /** Last successfully processed event id, or null before any event. */
  lastEventId: string | null;
  /** Channel the cursor belongs to, so cursors are not mixed across streams. */
  channel: NotificationChannel;
  /** ISO-8601 timestamp of the last update, for staleness diagnostics. */
  updatedAt: string;
}

/** Structured error surfaced by the notification stream. */
export interface NotificationStreamError {
  /** HTTP status when the failure originated from a response. */
  status?: number;
  /** Stable machine-readable code for metrics and diagnostics. */
  code:
    | 'unauthorized'
    | 'forbidden'
    | 'network'
    | 'parse'
    | 'unknown';
  /** Human-readable message safe to surface in the UI. */
  message: string;
  /** Whether the client may retry this failure. */
  retryable: boolean;
}
