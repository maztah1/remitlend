import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Offline-aware read/action behavior for the frontend.
 *
 * - Reads: while offline we surface that data is last-known/cached and must not
 *   be treated as authoritative (no fabricated financial or chain state).
 * - Actions: while offline we block actions and offer to queue them, then
 *   reconcile (flush) the queue when connectivity returns.
 *
 * The component is intentionally dependency-free and derives all user-visible
 * status from the browser's authoritative connectivity signals
 * (`navigator.onLine` + `online`/`offline` events).
 */

export type OfflineAction = () => void | Promise<void>;

export interface OfflineBannerProps {
  /** Optional callback invoked with each queued action when connectivity returns. */
  onReconcile?: (action: OfflineAction) => void | Promise<void>;
  /** Optional override for tests / SSR where `navigator` is unavailable. */
  initialOnline?: boolean;
  /** Optional label describing the cached read source, e.g. "last synced". */
  cachedLabel?: string;
}

function readOnline(initialOnline?: boolean): boolean {
  if (typeof initialOnline === 'boolean') return initialOnline;
  if (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean') {
    return navigator.onLine;
  }
  // Unknown connectivity: assume online so we never fabricate an offline state.
  return true;
}

export function OfflineBanner({
  onReconcile,
  initialOnline,
  cachedLabel = 'last synced',
}: OfflineBannerProps) {
  const [online, setOnline] = useState<boolean>(() => readOnline(initialOnline));
  const [queued, setQueued] = useState<OfflineAction[]>([]);
  const [reconciling, setReconciling] = useState(false);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const queuedRef = useRef<OfflineAction[]>([]);

  queuedRef.current = queued;

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Re-sync with the authoritative signal in case it changed before mount.
    setOnline(readOnline(initialOnline));

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [initialOnline]);

  // Reconcile queued actions once connectivity returns.
  useEffect(() => {
    if (!online || reconciling || queuedRef.current.length === 0) return;

    let cancelled = false;
    const pending = queuedRef.current;

    const flush = async () => {
      setReconciling(true);
      setReconcileError(null);
      const remaining: OfflineAction[] = [];

      for (const action of pending) {
        if (cancelled) {
          remaining.push(action);
          continue;
        }
        try {
          if (onReconcile) {
            await onReconcile(action);
          } else {
            await action();
          }
        } catch (err) {
          // Keep failed actions queued for a bounded retry on next reconnect.
          remaining.push(action);
          setReconcileError(
            err instanceof Error ? err.message : 'Failed to reconcile offline action',
          );
        }
      }

      if (!cancelled) {
        setQueued(remaining);
        setReconciling(false);
      }
    };

    void flush();

    return () => {
      cancelled = true;
    };
  }, [online, reconciling, onReconcile]);

  /**
   * Run an action immediately when online, or queue it while offline.
   * Returns `true` when the action ran, `false` when it was queued.
   */
  const runOrQueue = useCallback(
    (action: OfflineAction): boolean => {
      if (online) {
        void action();
        return true;
      }
      setQueued((prev) => [...prev, action]);
      return false;
    },
    [online],
  );

  const clearQueue = useCallback(() => {
    setQueued([]);
    setReconcileError(null);
  }, []);

  if (online && queued.length === 0 && !reconcileError) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      data-online={online}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.5rem 0.75rem',
        background: online ? '#e6f4ea' : '#fdecea',
        color: online ? '#1e4620' : '#611a15',
        borderBottom: '1px solid rgba(0,0,0,0.08)',
        fontSize: '0.875rem',
      }}
    >
      <span>
        {online
          ? `Back online — reconciling ${queued.length} queued action${queued.length === 1 ? '' : 's'}.`
          : `You are offline. Showing cached data (${cachedLabel}); actions are paused.`}
      </span>

      {!online && queued.length > 0 && (
        <span data-testid="offline-queued-count">
          {queued.length} action{queued.length === 1 ? '' : 's'} queued
        </span>
      )}

      {reconciling && <span data-testid="offline-reconciling">Reconciling…</span>}

      {reconcileError && (
        <span role="alert" data-testid="offline-reconcile-error">
          {reconcileError}
        </span>
      )}

      {queued.length > 0 && (
        <button type="button" onClick={clearQueue} disabled={reconciling}>
          Discard queued
        </button>
      )}
    </div>
  );
}

export default OfflineBanner;
