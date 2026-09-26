import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Offline-aware status hook.
 *
 * Exposes the browser's authoritative connectivity signal so reads can fall
 * back to last-known data and actions can be blocked/queued while offline.
 * No financial or chain state is fabricated here: consumers decide how to
 * surface cached data and must reconcile against the API on reconnect.
 */
export interface OfflineStatus {
  /** True when the browser reports no network connectivity. */
  isOffline: boolean;
  /** True once the initial connectivity signal has been read. */
  isReady: boolean;
  /** True when connectivity was restored after being offline. */
  isReconnected: boolean;
  /** Timestamp (ms) of the last observed connectivity change. */
  lastChangedAt: number | null;
  /**
   * Run an action only when online. Returns false (without invoking the
   * action) when offline so callers can queue or surface a blocked state.
   */
  runWhenOnline: <T>(action: () => T) => T | undefined;
}

function readOnline(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') {
    // Assume online when the platform cannot report connectivity so we never
    // silently block actions on unsupported environments.
    return true;
  }
  return navigator.onLine;
}

export function useOfflineStatus(): OfflineStatus {
  const [isOffline, setIsOffline] = useState<boolean>(() => !readOnline());
  const [isReady, setIsReady] = useState<boolean>(false);
  const [isReconnected, setIsReconnected] = useState<boolean>(false);
  const [lastChangedAt, setLastChangedAt] = useState<number | null>(null);
  const wasOfflineRef = useRef<boolean>(!readOnline());

  useEffect(() => {
    if (typeof window === 'undefined') {
      setIsReady(true);
      return;
    }

    const sync = () => {
      const online = readOnline();
      const offline = !online;
      setIsOffline(offline);
      setLastChangedAt(Date.now());
      if (wasOfflineRef.current && online) {
        setIsReconnected(true);
      }
      wasOfflineRef.current = offline;
    };

    sync();
    setIsReady(true);

    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  const runWhenOnline = useCallback(
    <T,>(action: () => T): T | undefined => {
      if (!readOnline()) {
        return undefined;
      }
      return action();
    },
    [],
  );

  return { isOffline, isReady, isReconnected, lastChangedAt, runWhenOnline };
}

export default useOfflineStatus;
