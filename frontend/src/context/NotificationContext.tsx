import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * Notification payload as delivered by the deployed SSE contract.
 * The shape is intentionally preserved for compatibility with existing consumers.
 */
export interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  createdAt: string;
  read?: boolean;
  metadata?: Record<string, unknown>;
}

export interface NotificationContextValue {
  notifications: Notification[];
  unreadCount: number;
  connected: boolean;
  error: string | null;
  markAsRead: (id: string) => void;
  markAllAsRead: () => void;
  clear: () => void;
  reconnect: () => void;
}

const NotificationContext = createContext<NotificationContextValue | undefined>(
  undefined,
);

const MAX_NOTIFICATIONS = 100;
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;

/**
 * Builds the SSE endpoint URL. The last received event id is passed as a
 * `lastEventId` query param so the server can replay missed notifications on
 * reconnect. This is additive and does not change the deployed contract.
 */
function buildStreamUrl(baseUrl: string, lastEventId: string | null): string {
  if (!lastEventId) {
    return baseUrl;
  }
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}lastEventId=${encodeURIComponent(lastEventId)}`;
}

function isAuthorizationFailure(status: number): boolean {
  return status === 401 || status === 403;
}

export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceRef = useRef<EventSource | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  // Cursor of the last successfully received event. Persisted across
  // reconnects so missed notifications are replayed instead of lost.
  const lastEventIdRef = useRef<string | null>(null);
  // Once an authorization failure occurs we stop reconnecting until the
  // consumer explicitly calls reconnect().
  const stoppedRef = useRef(false);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const closeSource = useCallback(() => {
    if (sourceRef.current) {
      sourceRef.current.close();
      sourceRef.current = null;
    }
  }, []);

  const upsertNotification = useCallback((incoming: Notification) => {
    setNotifications((prev) => {
      const existingIndex = prev.findIndex((n) => n.id === incoming.id);
      if (existingIndex >= 0) {
        const next = prev.slice();
        next[existingIndex] = { ...next[existingIndex], ...incoming };
        return next;
      }
      const next = [incoming, ...prev];
      return next.length > MAX_NOTIFICATIONS
        ? next.slice(0, MAX_NOTIFICATIONS)
        : next;
    });
  }, []);

  const connect = useCallback(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
      return;
    }
    if (stoppedRef.current) {
      return;
    }

    closeSource();
    clearReconnectTimer();

    const baseUrl = '/api/notifications/stream';
    const url = buildStreamUrl(baseUrl, lastEventIdRef.current);
    const source = new EventSource(url, { withCredentials: true });
    sourceRef.current = source;

    source.onopen = () => {
      reconnectAttemptsRef.current = 0;
      setConnected(true);
      setError(null);
    };

    source.onmessage = (event: MessageEvent) => {
      // Track the cursor before parsing so a malformed payload does not cause
      // the same event to be replayed forever.
      if (event.lastEventId) {
        lastEventIdRef.current = event.lastEventId;
      }
      try {
        const parsed = JSON.parse(event.data) as Notification;
        if (parsed && typeof parsed.id === 'string') {
          upsertNotification(parsed);
        }
      } catch {
        // Ignore malformed frames; the cursor has already advanced.
      }
    };

    source.onerror = () => {
      setConnected(false);
      closeSource();

      // EventSource exposes no status code directly. When the browser gives up
      // (readyState CLOSED) after an auth failure we surface an error and stop
      // looping; otherwise we schedule a bounded exponential backoff retry.
      if (source.readyState === EventSource.CLOSED) {
        stoppedRef.current = true;
        setError('Notification stream authorization failed. Please sign in again.');
        return;
      }

      const attempt = reconnectAttemptsRef.current + 1;
      reconnectAttemptsRef.current = attempt;
      const delay = Math.min(
        BASE_RECONNECT_DELAY_MS * 2 ** (attempt - 1),
        MAX_RECONNECT_DELAY_MS,
      );
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };
  }, [clearReconnectTimer, closeSource, upsertNotification]);

  const reconnect = useCallback(() => {
    stoppedRef.current = false;
    reconnectAttemptsRef.current = 0;
    setError(null);
    connect();
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      stoppedRef.current = true;
      clearReconnectTimer();
      closeSource();
    };
  }, [clearReconnectTimer, closeSource, connect]);

  const markAsRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clear = useCallback(() => {
    setNotifications([]);
  }, []);

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.read).length,
    [notifications],
  );

  const value = useMemo<NotificationContextValue>(
    () => ({
      notifications,
      unreadCount,
      connected,
      error,
      markAsRead,
      markAllAsRead,
      clear,
      reconnect,
    }),
    [
      notifications,
      unreadCount,
      connected,
      error,
      markAsRead,
      markAllAsRead,
      clear,
      reconnect,
    ],
  );

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
};

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotifications must be used within a NotificationProvider');
  }
  return ctx;
}

export default NotificationContext;
