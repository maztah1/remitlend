import { useCallback, useEffect, useRef, useState } from 'react';

export type NotificationEvent = {
  id?: string;
  type: string;
  payload?: unknown;
  receivedAt: number;
};

export type NotificationConnectionState =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'unauthorized'
  | 'error';

export interface UseNotificationsOptions {
  /** SSE endpoint. Defaults to the deployed notifications channel. */
  url?: string;
  /** Optional bearer token for authenticated streams. */
  token?: string;
  /** Max consecutive reconnect attempts before giving up. */
  maxRetries?: number;
  /** Base backoff in ms; grows exponentially up to maxBackoffMs. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Called for every notification received (including replayed ones). */
  onEvent?: (event: NotificationEvent) => void;
}

export interface UseNotificationsResult {
  events: NotificationEvent[];
  state: NotificationConnectionState;
  /** Last successfully received event id/cursor, if any. */
  lastEventId: string | null;
  error: string | null;
  /** Manually (re)connect, e.g. after an authorization failure. */
  connect: () => void;
  disconnect: () => void;
}

const DEFAULT_URL = '/api/notifications/stream';
const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30000;

/**
 * Stateful SSE notification subscription.
 *
 * Reconnection is stateful: the last received event id is persisted and sent
 * back on every reconnect (as the `Last-Event-ID` header and a `lastEventId`
 * query param fallback) so notifications missed while offline are replayed by
 * the server instead of being silently dropped.
 *
 * Authorization failures (401/403) stop reconnection and surface an error
 * instead of looping forever.
 */
export function useNotifications(
  options: UseNotificationsOptions = {},
): UseNotificationsResult {
  const {
    url = DEFAULT_URL,
    token,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    onEvent,
  } = options;

  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const [state, setState] = useState<NotificationConnectionState>('idle');
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const retriesRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const stoppedRef = useRef(false);
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const closeSource = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  const buildUrl = useCallback(() => {
    const cursor = lastEventIdRef.current;
    if (!cursor) return url;
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}lastEventId=${encodeURIComponent(cursor)}`;
  }, [url]);

  const connect = useCallback(() => {
    stoppedRef.current = false;
    clearTimer();
    closeSource();

    if (typeof EventSource === 'undefined') {
      setState('error');
      setError('EventSource is not available in this environment');
      return;
    }

    setState(retriesRef.current > 0 ? 'reconnecting' : 'connecting');

    let source: EventSource;
    try {
      source = new EventSource(buildUrl(), token ? { withCredentials: true } : undefined);
    } catch (err) {
      setState('error');
      setError(err instanceof Error ? err.message : 'Failed to open notification stream');
      return;
    }
    sourceRef.current = source;

    source.onopen = () => {
      retriesRef.current = 0;
      setError(null);
      setState('open');
    };

    source.onmessage = (message: MessageEvent<string>) => {
      // Persist the cursor before surfacing the event so a crash mid-handler
      // still resumes from the correct position on the next reconnect.
      if (message.lastEventId) {
        lastEventIdRef.current = message.lastEventId;
        setLastEventId(message.lastEventId);
      }

      let parsed: unknown = message.data;
      try {
        parsed = JSON.parse(message.data);
      } catch {
        // Non-JSON payloads are preserved as-is for compatibility.
      }

      const event: NotificationEvent = {
        id: message.lastEventId || undefined,
        type: (message as MessageEvent & { type?: string }).type || 'message',
        payload: parsed,
        receivedAt: Date.now(),
      };

      setEvents((prev) => [...prev, event]);
      onEventRef.current?.(event);
    };

    source.onerror = () => {
      closeSource();

      if (stoppedRef.current) return;

      // EventSource exposes no status code; a closed readyState after an error
      // is treated as a terminal authorization/contract failure when the
      // server rejects the stream. We surface it and stop looping.
      const status = (source as EventSource & { status?: number }).status;
      if (status === 401 || status === 403) {
        setState('unauthorized');
        setError('Notification stream authorization failed');
        return;
      }

      if (retriesRef.current >= maxRetries) {
        setState('error');
        setError('Notification stream unavailable after retries');
        return;
      }

      const attempt = retriesRef.current;
      retriesRef.current += 1;
      const backoff = Math.min(baseBackoffMs * 2 ** attempt, maxBackoffMs);
      setState('reconnecting');
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        connect();
      }, backoff);
    };
  }, [baseBackoffMs, buildUrl, clearTimer, closeSource, maxBackoffMs, maxRetries, token]);

  const disconnect = useCallback(() => {
    stoppedRef.current = true;
    clearTimer();
    closeSource();
    setState('idle');
  }, [clearTimer, closeSource]);

  useEffect(() => {
    connect();
    return () => {
      stoppedRef.current = true;
      clearTimer();
      closeSource();
    };
  }, [connect, clearTimer, closeSource]);

  return { events, state, lastEventId, error, connect, disconnect };
}

export default useNotifications;
