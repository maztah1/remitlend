import { useCallback } from 'react';
import {
  useQuery,
  useMutation,
  useQueryClient,
  type QueryClient,
  type UseQueryOptions,
} from '@tanstack/react-query';
import { apiClient } from '../services/apiClient';

/**
 * Single source of truth for financial-resource query keys.
 *
 * Key shapes are stable and serializable so they can be persisted, logged,
 * and shared across hooks without drifting. All financial resources
 * (loans, loan events/history, remittances, scores, notifications) derive
 * their keys from this module.
 */
export const financialKeys = {
  all: ['financial'] as const,
  loans: {
    all: ['financial', 'loans'] as const,
    list: (filters?: Record<string, unknown>) =>
      ['financial', 'loans', 'list', filters ?? {}] as const,
    detail: (loanId: string) =>
      ['financial', 'loans', 'detail', loanId] as const,
    events: (loanId: string) =>
      ['financial', 'loans', 'events', loanId] as const,
  },
  remittances: {
    all: ['financial', 'remittances'] as const,
    list: (filters?: Record<string, unknown>) =>
      ['financial', 'remittances', 'list', filters ?? {}] as const,
    detail: (remittanceId: string) =>
      ['financial', 'remittances', 'detail', remittanceId] as const,
  },
  scores: {
    all: ['financial', 'scores'] as const,
    detail: (subjectId: string) =>
      ['financial', 'scores', 'detail', subjectId] as const,
  },
  notifications: {
    all: ['financial', 'notifications'] as const,
    list: (filters?: Record<string, unknown>) =>
      ['financial', 'notifications', 'list', filters ?? {}] as const,
  },
} as const;

/**
 * Centralized invalidation helpers.
 *
 * Each helper invalidates only the dependent financial queries for the
 * affected resource, avoiding over-invalidation of unrelated caches.
 */
export const financialInvalidation = {
  invalidateLoans: (queryClient: QueryClient, loanId?: string) => {
    queryClient.invalidateQueries({ queryKey: financialKeys.loans.all });
    if (loanId) {
      queryClient.invalidateQueries({
        queryKey: financialKeys.loans.detail(loanId),
      });
      queryClient.invalidateQueries({
        queryKey: financialKeys.loans.events(loanId),
      });
    }
  },
  invalidateRemittances: (queryClient: QueryClient, remittanceId?: string) => {
    queryClient.invalidateQueries({ queryKey: financialKeys.remittances.all });
    if (remittanceId) {
      queryClient.invalidateQueries({
        queryKey: financialKeys.remittances.detail(remittanceId),
      });
    }
  },
  invalidateScores: (queryClient: QueryClient, subjectId?: string) => {
    queryClient.invalidateQueries({ queryKey: financialKeys.scores.all });
    if (subjectId) {
      queryClient.invalidateQueries({
        queryKey: financialKeys.scores.detail(subjectId),
      });
    }
  },
  invalidateNotifications: (queryClient: QueryClient) => {
    queryClient.invalidateQueries({ queryKey: financialKeys.notifications.all });
  },
};

/**
 * Shared retry policy for financial queries.
 *
 * Authorization failures (401/403) are never retried; transient dependency
 * failures are retried with bounded exponential backoff.
 */
const FINANCIAL_RETRY_LIMIT = 3;

function isAuthorizationError(error: unknown): boolean {
  const status = (error as { status?: number; response?: { status?: number } })
    ?.status ??
    (error as { response?: { status?: number } })?.response?.status;
  return status === 401 || status === 403;
}

function financialRetry(failureCount: number, error: unknown): boolean {
  if (isAuthorizationError(error)) {
    return false;
  }
  return failureCount < FINANCIAL_RETRY_LIMIT;
}

function financialRetryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

export interface Loan {
  id: string;
  amount: number;
  status: string;
  [key: string]: unknown;
}

export interface LoanEvent {
  id: string;
  loanId: string;
  type: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface LoanFilters {
  status?: string;
  [key: string]: unknown;
}

/**
 * Fetch the list of loans.
 */
export function useLoans(
  filters?: LoanFilters,
  options?: Omit<
    UseQueryOptions<Loan[], Error, Loan[], ReturnType<typeof financialKeys.loans.list>>,
    'queryKey' | 'queryFn'
  >,
) {
  return useQuery({
    queryKey: financialKeys.loans.list(filters),
    queryFn: async () => {
      const response = await apiClient.get<Loan[]>('/loans', {
        params: filters,
      });
      return response.data;
    },
    retry: financialRetry,
    retryDelay: financialRetryDelay,
    staleTime: 30_000,
    ...options,
  });
}

/**
 * Fetch a single loan by id.
 */
export function useLoan(
  loanId: string,
  options?: Omit<
    UseQueryOptions<Loan, Error, Loan, ReturnType<typeof financialKeys.loans.detail>>,
    'queryKey' | 'queryFn'
  >,
) {
  return useQuery({
    queryKey: financialKeys.loans.detail(loanId),
    queryFn: async () => {
      const response = await apiClient.get<Loan>(`/loans/${loanId}`);
      return response.data;
    },
    enabled: Boolean(loanId),
    retry: financialRetry,
    retryDelay: financialRetryDelay,
    staleTime: 30_000,
    ...options,
  });
}

/**
 * Fetch the event/history stream for a loan.
 */
export function useLoanEvents(
  loanId: string,
  options?: Omit<
    UseQueryOptions<LoanEvent[], Error, LoanEvent[], ReturnType<typeof financialKeys.loans.events>>,
    'queryKey' | 'queryFn'
  >,
) {
  return useQuery({
    queryKey: financialKeys.loans.events(loanId),
    queryFn: async () => {
      const response = await apiClient.get<LoanEvent[]>(`/loans/${loanId}/events`);
      return response.data;
    },
    enabled: Boolean(loanId),
    retry: financialRetry,
    retryDelay: financialRetryDelay,
    staleTime: 15_000,
    ...options,
  });
}

/**
 * Mutation hook for loan actions that invalidates all dependent financial
 * queries (loan detail, list, and events) on success.
 */
export function useLoanMutation<TVariables = unknown, TData = unknown>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  getLoanId?: (variables: TVariables, data: TData) => string | undefined,
) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn,
    retry: financialRetry,
    retryDelay: financialRetryDelay,
    onSuccess: (data, variables) => {
      const loanId = getLoanId?.(variables, data);
      financialInvalidation.invalidateLoans(queryClient, loanId);
    },
  });
}

/**
 * Imperative invalidation hook for callers that need to refresh financial
 * caches outside of a mutation lifecycle.
 */
export function useFinancialInvalidation() {
  const queryClient = useQueryClient();

  const invalidateLoans = useCallback(
    (loanId?: string) => financialInvalidation.invalidateLoans(queryClient, loanId),
    [queryClient],
  );

  const invalidateRemittances = useCallback(
    (remittanceId?: string) =>
      financialInvalidation.invalidateRemittances(queryClient, remittanceId),
    [queryClient],
  );

  const invalidateScores = useCallback(
    (subjectId?: string) => financialInvalidation.invalidateScores(queryClient, subjectId),
    [queryClient],
  );

  const invalidateNotifications = useCallback(
    () => financialInvalidation.invalidateNotifications(queryClient),
    [queryClient],
  );

  return {
    invalidateLoans,
    invalidateRemittances,
    invalidateScores,
    invalidateNotifications,
  };
}
