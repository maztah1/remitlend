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
 * Offline-aware behavior for reads and actions.
 *
 * - Reads: consumers can serve last-known (cached) data while offline and are
 *   told when that data is stale so they never present it as authoritative.
 * - Actions: while offline, actions are either blocked or queued and reconciled
 *   once connectivity returns. Financial/chain state is never fabricated; queued
 *   actions are only replayed against the authoritative source on reconnect.
 */

export type OfflineActionStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface OfflineAction {
  id: string;
  label: string;
  run: () => Promise<unknown>;
  status: OfflineActionStatus;
  error?: string;
  enqueuedAt: number;
}

export interface OfflineContextValue {
  /** True when the browser reports no connectivity. */
  isOffline: boolean;
  /** True once the initial connectivity probe has resolved. */
  isReady: boolean;
  /** Timestamp of the last successful connectivity transition to online. */
  lastOnlineAt: number | null;
  /**
   * Whether reads should fall back to last-known cached data. Consumers must
   * surface `isStale` alongside any cached value they render.
   */
  shouldUseCachedReads: boolean;
  /**
   * Run an action now when online, or queue it when offline. Returns the action
   * id. When `blockWhenOffline` is true the action is rejected instead of queued.
   */
  runOrQueue: (
    label: string,
    run: () => Promise<unknown>,
    options?: { blockWhenOffline?: boolean },
  ) => { id: string; queued: boolean };
  /** Pending actions awaiting reconciliation. */
  pendingActions: OfflineAction[];
  /** Manually attempt to flush queued actions (e.g. after a retry tap). */
  flushQueue: () => Promise<void>;
  /** Remove a queued action without running it. */
  discardAction: (id: string) => void;
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

function getInitialOffline(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') {
    return false;
  }
  return !navigator.onLine;
}

let actionCounter = 0;
function nextActionId(): string {
  actionCounter += 1;
  return `offline-action-${Date.now()}-${actionCounter}`;
}

export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const [isOffline, setIsOffline] = useState<boolean>(getInitialOffline);
  const [isReady, setIsReady] = useState<boolean>(false);
  const [lastOnlineAt, setLastOnlineAt] = useState<number | null>(null);
  const [pendingActions, setPendingActions] = useState<OfflineAction[]>([]);

  const isOfflineRef = useRef(isOffline);
  isOfflineRef.current = isOffline;
  const flushingRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      setIsReady(true);
      return;
    }

    const handleOnline = () => {
      setIsOffline(false);
      setLastOnlineAt(Date.now());
    };
    const handleOffline = () => {
      setIsOffline(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    setIsOffline(getInitialOffline());
    setIsReady(true);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const flushQueue = useCallback(async () => {
    if (isOfflineRef.current || flushingRef.current) {
      return;
    }
    flushingRef.current = true;
    try {
      // Snapshot the queue; new actions enqueued during the flush are handled
      // on the next pass so we never lose or double-run an action.
      const snapshot = pendingActions;
      for (const action of snapshot) {
        if (isOfflineRef.current) {
          break;
        }
        setPendingActions((prev) =>
          prev.map((a) => (a.id === action.id ? { ...a, status: 'running' } : a)),
        );
        try {
          await action.run();
          setPendingActions((prev) => prev.filter((a) => a.id !== action.id));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Action failed';
          setPendingActions((prev) =>
            prev.map((a) =>
              a.id === action.id ? { ...a, status: 'failed', error: message } : a,
            ),
          );
        }
      }
    } finally {
      flushingRef.current = false;
    }
  }, [pendingActions]);

  // Reconcile queued actions when connectivity returns.
  useEffect(() => {
    if (!isOffline && pendingActions.length > 0) {
      void flushQueue();
    }
  }, [isOffline, pendingActions.length, flushQueue]);

  const runOrQueue = useCallback(
    (
      label: string,
      run: () => Promise<unknown>,
      options?: { blockWhenOffline?: boolean },
    ): { id: string; queued: boolean } => {
      const id = nextActionId();
      if (isOfflineRef.current) {
        if (options?.blockWhenOffline) {
          throw new Error('Action unavailable while offline');
        }
        setPendingActions((prev) => [
          ...prev,
          { id, label, run, status: 'queued', enqueuedAt: Date.now() },
        ]);
        return { id, queued: true };
      }
      // Online: run immediately against the authoritative source.
      void run().catch(() => {
        /* surfaced by the caller's own error handling */
      });
      return { id, queued: false };
    },
    [],
  );

  const discardAction = useCallback((id: string) => {
    setPendingActions((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const value = useMemo<OfflineContextValue>(
    () => ({
      isOffline,
      isReady,
      lastOnlineAt,
      shouldUseCachedReads: isOffline,
      runOrQueue,
      pendingActions,
      flushQueue,
      discardAction,
    }),
    [
      isOffline,
      isReady,
      lastOnlineAt,
      runOrQueue,
      pendingActions,
      flushQueue,
      discardAction,
    ],
  );

  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOffline(): OfflineContextValue {
  const ctx = useContext(OfflineContext);
  if (!ctx) {
    throw new Error('useOffline must be used within an OfflineProvider');
  }
  return ctx;
}

export default OfflineContext;
