/**
 * lib/offlineQueue.ts
 *
 * A tiny persistent queue for mutating requests (POST/PUT/PATCH/DELETE) made
 * while the browser is offline. Entries survive reloads via localStorage and
 * are replayed in order once connectivity returns.
 *
 * This is deliberately transport-agnostic: callers hand us a serialisable
 * description of the fetch they wanted to make, and we replay it with `fetch`.
 */

import { TRACEPARENT_HEADER, outboundTraceparent } from "./traceContext";

export interface QueuedRequest {
  id: string;
  url: string;
  method: string;
  /** Header entries excluding anything sensitive the caller chooses to omit. */
  headers: Record<string, string>;
  /** JSON-serialised body, if any. */
  body?: string;
  /** Human-readable label surfaced in the sync UI. */
  label?: string;
  queuedAt: number;
  attempts: number;
}

export type QueueListener = (queue: QueuedRequest[]) => void;

const STORAGE_KEY = "remitlend:offline-queue";
const MAX_ATTEMPTS = 5;

const listeners = new Set<QueueListener>();

function canPersist(): boolean {
  return typeof window !== "undefined" && "localStorage" in window;
}

function read(): QueuedRequest[] {
  if (!canPersist()) return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as QueuedRequest[]) : [];
  } catch {
    return [];
  }
}

function write(queue: QueuedRequest[]): void {
  if (canPersist()) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    } catch {
      /* quota / private mode — keep going with in-memory only */
    }
  }
  for (const listener of listeners) listener(queue);
}

export function getQueue(): QueuedRequest[] {
  return read();
}

export function subscribe(listener: QueueListener): () => void {
  listeners.add(listener);
  listener(read());
  return () => listeners.delete(listener);
}

export function enqueueRequest(
  entry: Omit<QueuedRequest, "id" | "queuedAt" | "attempts">,
): QueuedRequest {
  const queued: QueuedRequest = {
    ...entry,
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `q_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    queuedAt: Date.now(),
    attempts: 0,
  };
  write([...read(), queued]);
  return queued;
}

export function removeFromQueue(id: string): void {
  write(read().filter((item) => item.id !== id));
}

export function clearQueue(): void {
  write([]);
}

let flushing = false;

export interface FlushResult {
  succeeded: number;
  failed: number;
  remaining: number;
}

/**
 * Replay every queued request in order. Successful and permanently-failed
 * entries are dropped; transient failures stay queued for the next attempt.
 */
export async function flushQueue(): Promise<FlushResult> {
  if (flushing) return { succeeded: 0, failed: 0, remaining: read().length };
  flushing = true;

  let succeeded = 0;
  let failed = 0;

  try {
    for (const item of read()) {
      try {
        // Replays happen long after the original attempt, so the queued trace
        // context would be stale and misleading; mint a fresh child span at
        // replay time instead (the API still ties it to the offline flow via
        // the request id). See #414.
        const res = await fetch(item.url, {
          method: item.method,
          headers: { ...item.headers, [TRACEPARENT_HEADER]: outboundTraceparent() },
          body: item.body,
        });

        if (res.ok || (res.status >= 400 && res.status < 500)) {
          // 2xx = done. 4xx = client error that a retry won't fix — drop it.
          removeFromQueue(item.id);
          if (res.ok) succeeded += 1;
          else failed += 1;
        } else {
          throw new Error(`Server responded ${res.status}`);
        }
      } catch {
        const attempts = item.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) {
          removeFromQueue(item.id);
          failed += 1;
        } else {
          write(read().map((q) => (q.id === item.id ? { ...q, attempts } : q)));
        }
      }
    }
  } finally {
    flushing = false;
  }

  return { succeeded, failed, remaining: read().length };
}
