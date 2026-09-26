/**
 * Centralized query key registry for financial resources.
 *
 * Single source of truth for React Query keys so that reads and
 * invalidations stay in sync. Keys are plain, serializable arrays with a
 * stable shape: [resource, ...scope]. Never embed non-serializable values
 * (functions, class instances, Dates) — pass primitives only.
 *
 * Compatibility: this module only describes client-side cache keys. It does
 * not change backend contracts or response shapes.
 */

export const queryKeys = {
  loans: {
    all: ['loans'] as const,
    list: (filters?: Record<string, unknown>) =>
      filters ? (['loans', 'list', filters] as const) : (['loans', 'list'] as const),
    detail: (loanId: string) => ['loans', 'detail', loanId] as const,
    events: (loanId: string) => ['loans', 'detail', loanId, 'events'] as const,
  },
  remittances: {
    all: ['remittances'] as const,
    list: (filters?: Record<string, unknown>) =>
      filters
        ? (['remittances', 'list', filters] as const)
        : (['remittances', 'list'] as const),
    detail: (remittanceId: string) => ['remittances', 'detail', remittanceId] as const,
  },
  scores: {
    all: ['scores'] as const,
    detail: (subjectId: string) => ['scores', 'detail', subjectId] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    list: (filters?: Record<string, unknown>) =>
      filters
        ? (['notifications', 'list', filters] as const)
        : (['notifications', 'list'] as const),
  },
} as const;

export type QueryKeys = typeof queryKeys;

/**
 * Centralized invalidation helpers.
 *
 * Each helper invalidates only the financial resources affected by a
 * mutation, avoiding over-invalidation of unrelated caches. Pass the
 * `queryClient` from `useQueryClient()`.
 */
export interface QueryInvalidator {
  invalidateQueries: (options: { queryKey: readonly unknown[] }) => Promise<void>;
}

export const invalidate = {
  /** Loan created/updated/deleted: refresh list and the affected detail + events. */
  loans: async (client: QueryInvalidator, loanId?: string) => {
    await client.invalidateQueries({ queryKey: queryKeys.loans.all });
    if (loanId) {
      await client.invalidateQueries({ queryKey: queryKeys.loans.detail(loanId) });
      await client.invalidateQueries({ queryKey: queryKeys.loans.events(loanId) });
    }
  },
  /** Loan event appended: refresh the loan's events and detail. */
  loanEvents: async (client: QueryInvalidator, loanId: string) => {
    await client.invalidateQueries({ queryKey: queryKeys.loans.events(loanId) });
    await client.invalidateQueries({ queryKey: queryKeys.loans.detail(loanId) });
  },
  /** Remittance created/updated: refresh list and the affected detail. */
  remittances: async (client: QueryInvalidator, remittanceId?: string) => {
    await client.invalidateQueries({ queryKey: queryKeys.remittances.all });
    if (remittanceId) {
      await client.invalidateQueries({
        queryKey: queryKeys.remittances.detail(remittanceId),
      });
    }
  },
  /** Score recomputed: refresh the affected subject's score. */
  scores: async (client: QueryInvalidator, subjectId?: string) => {
    await client.invalidateQueries({ queryKey: queryKeys.scores.all });
    if (subjectId) {
      await client.invalidateQueries({ queryKey: queryKeys.scores.detail(subjectId) });
    }
  },
  /** Notifications changed: refresh the notification list. */
  notifications: async (client: QueryInvalidator) => {
    await client.invalidateQueries({ queryKey: queryKeys.notifications.all });
  },
};
