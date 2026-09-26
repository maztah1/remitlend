"use client";

/**
 * components/providers/QueryProvider.tsx
 *
 * Wraps the application with TanStack Query's QueryClientProvider.
 * Must be a client component since QueryClient is browser-side state.
 *
 * Usage: wrap your root layout children with <QueryProvider>
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { useState, type ReactNode } from "react";
import { SessionExpiryHandler } from "./SessionExpiryHandler";
import { CSPDiagnostics } from "./CSPDiagnostics";

interface QueryProviderProps {
  children: ReactNode;
}

export function QueryProvider({ children }: QueryProviderProps) {
  /**
   * useState ensures a new QueryClient is created per component instance
   * (not shared across requests in SSR environments).
   */
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Data is considered fresh for 60 seconds — within this window a
            // component that mounts (or a page that is navigated back to) reuses
            // the cache instead of hitting the network.
            staleTime: 60 * 1000,
            // Keep inactive/unused data in the cache for 5 minutes before it is
            // garbage-collected. This makes back/forward navigation instant while
            // still bounding memory for long sessions.
            gcTime: 5 * 60 * 1000,
            // Retry failed requests (but don't spin when offline)
            retry: (failureCount) => {
              if (typeof navigator !== "undefined" && navigator.onLine === false) {
                return false;
              }
              return failureCount < 2;
            },
            // Do NOT refetch just because the window regained focus. Focus
            // refetches caused visible flicker and redundant load on pages that
            // are already covered by `staleTime` + explicit invalidation after
            // mutations. Opt back in per-query for genuinely live data.
            refetchOnWindowFocus: false,
            // Only refetch on mount when the cached data is actually stale.
            refetchOnMount: true,
            // Refetch when connection is restored — cheap and usually desired.
            refetchOnReconnect: true,
          },
          mutations: {
            // Never retry mutations: most mutationFns are non-idempotent
            // (loan repayment, remittance creation, etc.) and retrying after
            // a transient error can duplicate a request the server already processed.
            retry: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      {/* Listen for 401 auth:session-expired events and trigger full logout */}
      <SessionExpiryHandler />
      <CSPDiagnostics />
      {children}
      {/* DevTools only render in development */}
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
