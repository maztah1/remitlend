import { QueryClient, type QueryKey } from '@tanstack/react-query';

/**
 * Single source of truth for query keys covering financial resources.
 *
 * Key shapes are stable and serializable so they can be persisted, logged,
 * and matched deterministically by invalidation helpers. Backend contracts
 * and response shapes are untouched; this module only governs client-side
 * cache identity.
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
      filters ? (['remittances', 'list', filters] as const) : (['remittances', 'list'] as const),
    detail: (remittanceId: string) => ['remittances', 'detail', remittanceId] as const,
  },
  scores: {
    all: ['scores'] as const,
    detail: (subjectId: string) => ['scores', 'detail', subjectId] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    list: (filters?: Record<string, unknown>) =>
      filters ? (['notifications', 'list', filters] as const) : (['notifications', 'list'] as const),
  },
} as const;

/**
 * Centralized invalidation helpers.
 *
 * Each helper invalidates only the financial resources that depend on the
 * mutated entity, avoiding over-invalidation of unrelated caches.
 */
export const invalidate = {
  loans: (client: QueryClient, loanId?: string) => {
    const tasks: Promise<void>[] = [client.invalidateQueries({ queryKey: queryKeys.loans.all })];
    if (loanId) {
      tasks.push(client.invalidateQueries({ queryKey: queryKeys.loans.detail(loanId) }));
      tasks.push(client.invalidateQueries({ queryKey: queryKeys.loans.events(loanId) }));
    }
    return Promise.all(tasks);
  },
  remittances: (client: QueryClient, remittanceId?: string) => {
    const tasks: Promise<void>[] = [
      client.invalidateQueries({ queryKey: queryKeys.remittances.all }),
    ];
    if (remittanceId) {
      tasks.push(client.invalidateQueries({ queryKey: queryKeys.remittances.detail(remittanceId) }));
    }
    return Promise.all(tasks);
  },
  scores: (client: QueryClient, subjectId?: string) => {
    const tasks: Promise<void>[] = [client.invalidateQueries({ queryKey: queryKeys.scores.all })];
    if (subjectId) {
      tasks.push(client.invalidateQueries({ queryKey: queryKeys.scores.detail(subjectId) }));
    }
    return Promise.all(tasks);
  },
  notifications: (client: QueryClient) =>
    client.invalidateQueries({ queryKey: queryKeys.notifications.all }),
};

/**
 * Shared retry policy for financial queries.
 *
 * Authorization failures (401/403) are never retried; transient dependency
 * failures are retried with bounded exponential backoff. Stale data is kept
 * visible while a refetch is in flight so the UI never blanks out.
 */
export function shouldRetryFinancialQuery(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  if (status === 401 || status === 403) {
    return false;
  }
  return failureCount < 3;
}

export function retryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryFinancialQuery,
        retryDelay,
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: false,
        placeholderData: (previous: unknown) => previous,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export const queryClient = createQueryClient();

export type FinancialQueryKey = QueryKey;
