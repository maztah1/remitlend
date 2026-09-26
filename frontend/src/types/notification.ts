/**
 * Notification domain types.
 *
 * Read-state consistency contract:
 * - The server is the authoritative source of truth for `status` (read/unread).
 * - Client state is treated as a cache that reconciles against server responses
 *   on every list refetch and mark-read / mark-all-read mutation.
 * - Unread counts MUST be derived from authoritative server responses, never
 *   from optimistic client-only state.
 */

export type NotificationStatus = 'unread' | 'read';

export interface Notification {
  id: string;
  title: string;
  body: string;
  status: NotificationStatus;
  action_url?: string | null;
  created_at: string;
  updated_at?: string;
}

/**
 * Bounded pagination envelope returned by the notifications list endpoint.
 * `limit` is capped server-side; clients must not request unbounded pages.
 */
export interface NotificationListResponse {
  items: Notification[];
  /** Authoritative unread count for the current user, from the server. */
  unread_count: number;
  /** Opaque cursor for the next page, or null when exhausted. */
  next_cursor: string | null;
  /** Whether more pages are available. */
  has_more: boolean;
}

/**
 * Response returned by mark-read / mark-all-read mutations.
 * The authoritative `unread_count` is used to reconcile the client cache.
 */
export interface NotificationMutationResponse {
  /** Notifications affected by the mutation, with authoritative status. */
  items: Notification[];
  /** Authoritative unread count after the mutation. */
  unread_count: number;
}

/**
 * Query parameters for the notifications list endpoint.
 * `limit` is bounded to prevent unbounded resource usage.
 */
export interface NotificationListParams {
  cursor?: string | null;
  limit?: number;
  status?: NotificationStatus;
}

/** Maximum page size accepted by the notifications list endpoint. */
export const NOTIFICATION_PAGE_SIZE_LIMIT = 50;

/** Default page size used when the caller does not specify one. */
export const NOTIFICATION_PAGE_SIZE_DEFAULT = 20;

/**
 * Clamp a requested page size into the bounded range accepted by the API.
 * Guards against unbounded polling / oversized pages from callers.
 */
export function clampNotificationLimit(limit?: number): number {
  if (limit === undefined || limit === null || Number.isNaN(limit)) {
    return NOTIFICATION_PAGE_SIZE_DEFAULT;
  }
  if (limit < 1) {
    return 1;
  }
  if (limit > NOTIFICATION_PAGE_SIZE_LIMIT) {
    return NOTIFICATION_PAGE_SIZE_LIMIT;
  }
  return Math.floor(limit);
}

/**
 * Reconcile a cached notification list with an authoritative server response.
 * Server entries win on conflict so read state stays consistent across refetches.
 */
export function reconcileNotifications(
  cached: Notification[],
  authoritative: Notification[],
): Notification[] {
  const byId = new Map<string, Notification>();
  for (const item of cached) {
    byId.set(item.id, item);
  }
  for (const item of authoritative) {
    byId.set(item.id, item);
  }
  return Array.from(byId.values()).sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
  );
}

/**
 * Derive the unread count from authoritative notification entries.
 * Used only as a fallback when the server does not return `unread_count`.
 */
export function deriveUnreadCount(items: Notification[]): number {
  let count = 0;
  for (const item of items) {
    if (item.status === 'unread') {
      count += 1;
    }
  }
  return count;
}
