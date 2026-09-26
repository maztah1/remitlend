import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Secure deep-link handling for transaction status (#336).
 *
 * Deep links look like:
 *   /tx/<chainId>/<txHash>
 *   /tx/<chainId>/<txHash>?network=<networkId>
 *
 * Only allowlisted routes are accepted, the chain/network must match the
 * configured deployment, and the transaction hash must be a well-formed
 * 32-byte hex string. Status resolution is bounded (timeout + retry cap)
 * and never trusts client-supplied status values.
 */

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ALLOWED_ROUTES = ['/tx'] as const;
const STATUS_TIMEOUT_MS = 8000;
const MAX_STATUS_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

// Configured deployment identity. Kept in sync with the deployed contracts.
const EXPECTED_CHAIN_ID = Number(process.env.REACT_APP_CHAIN_ID ?? '1');
const EXPECTED_NETWORK_ID = process.env.REACT_APP_NETWORK_ID ?? 'mainnet';

export type TxStatus =
  | 'pending'
  | 'confirmed'
  | 'failed'
  | 'unknown';

export interface TxStatusResult {
  status: TxStatus;
  confirmations: number;
  blockNumber: number | null;
  observedAt: number;
  stale: boolean;
}

export interface DeepLinkParseResult {
  ok: boolean;
  chainId?: number;
  networkId?: string;
  txHash?: string;
  error?: string;
}

/**
 * Parse and validate a transaction-status deep link. Pure and side-effect
 * free so it can be unit tested and reused by the router.
 */
export function parseTxDeepLink(rawUrl: string): DeepLinkParseResult {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) {
    return { ok: false, error: 'invalid_url' };
  }

  let url: URL;
  try {
    url = new URL(rawUrl, 'https://app.local');
  } catch {
    return { ok: false, error: 'invalid_url' };
  }

  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length !== 3) {
    return { ok: false, error: 'invalid_route' };
  }

  const [route, chainSegment, txHash] = segments;
  if (!ALLOWED_ROUTES.includes(`/${route}` as (typeof ALLOWED_ROUTES)[number])) {
    return { ok: false, error: 'route_not_allowed' };
  }

  const chainId = Number(chainSegment);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { ok: false, error: 'invalid_chain_id' };
  }
  if (chainId !== EXPECTED_CHAIN_ID) {
    return { ok: false, error: 'chain_mismatch' };
  }

  const networkId = url.searchParams.get('network') ?? EXPECTED_NETWORK_ID;
  if (networkId !== EXPECTED_NETWORK_ID) {
    return { ok: false, error: 'network_mismatch' };
  }

  if (!TX_HASH_RE.test(txHash)) {
    return { ok: false, error: 'invalid_tx_hash' };
  }

  return { ok: true, chainId, networkId, txHash: txHash.toLowerCase() };
}

/**
 * Resolve transaction status from the authoritative backend. Bounded by a
 * timeout and a retry cap; never derives status from the URL itself.
 */
export async function fetchTxStatus(
  txHash: string,
  signal?: AbortSignal,
): Promise<TxStatusResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  try {
    const res = await fetch(`/api/tx/${encodeURIComponent(txHash)}/status`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      credentials: 'same-origin',
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error('unauthorized');
    }
    if (res.status === 404) {
      return { status: 'unknown', confirmations: 0, blockNumber: null, observedAt: Date.now(), stale: false };
    }
    if (!res.ok) {
      throw new Error(`status_http_${res.status}`);
    }

    const body = (await res.json()) as Partial<TxStatusResult>;
    const status: TxStatus =
      body.status === 'pending' || body.status === 'confirmed' || body.status === 'failed'
        ? body.status
        : 'unknown';

    return {
      status,
      confirmations: Number.isFinite(body.confirmations) ? Number(body.confirmations) : 0,
      blockNumber: Number.isFinite(body.blockNumber) ? Number(body.blockNumber) : null,
      observedAt: Number.isFinite(body.observedAt) ? Number(body.observedAt) : Date.now(),
      stale: Boolean(body.stale),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

interface TxStatusViewProps {
  txHash: string;
}

function TxStatusView({ txHash }: TxStatusViewProps) {
  const [result, setResult] = useState<TxStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const retryRef = useRef(0);

  const load = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const next = await fetchTxStatus(txHash, signal);
        if (signal.aborted) return;
        setResult(next);
        retryRef.current = 0;
      } catch (err) {
        if (signal.aborted) return;
        const message = err instanceof Error ? err.message : 'unknown_error';
        if (message === 'unauthorized') {
          setError('You are not authorized to view this transaction.');
          return;
        }
        if (retryRef.current < MAX_STATUS_RETRIES) {
          const delay = RETRY_BASE_DELAY_MS * 2 ** retryRef.current;
          retryRef.current += 1;
          setTimeout(() => {
            if (!signal.aborted) void load(signal);
          }, delay);
          return;
        }
        setError('Unable to load transaction status. Please try again.');
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [txHash],
  );

  useEffect(() => {
    const controller = new AbortController();
    retryRef.current = 0;
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading && !result) {
    return <p role="status">Loading transaction status…</p>;
  }
  if (error) {
    return (
      <p role="alert" data-testid="tx-status-error">
        {error}
      </p>
    );
  }
  if (!result) {
    return <p role="status">No transaction status available.</p>;
  }

  return (
    <section aria-live="polite" data-testid="tx-status">
      <h2>Transaction status</h2>
      <p>
        Status: <strong>{result.status}</strong>
        {result.stale ? ' (stale)' : ''}
      </p>
      <p>Confirmations: {result.confirmations}</p>
      {result.blockNumber !== null && <p>Block: {result.blockNumber}</p>}
    </section>
  );
}

function TxDeepLinkRoute({ rawUrl }: { rawUrl: string }) {
  const parsed = useMemo(() => parseTxDeepLink(rawUrl), [rawUrl]);

  if (!parsed.ok || !parsed.txHash) {
    return (
      <p role="alert" data-testid="tx-deeplink-error">
        Invalid transaction link ({parsed.error}).
      </p>
    );
  }

  return <TxStatusView txHash={parsed.txHash} />;
}

export default function App() {
  const [path, setPath] = useState<string>(() =>
    typeof window !== 'undefined' ? window.location.pathname + window.location.search : '/',
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onPop = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const isTxRoute = path.startsWith('/tx/');

  return (
    <main>
      <h1>Handsoff</h1>
      {isTxRoute ? <TxDeepLinkRoute rawUrl={path} /> : <p>Welcome.</p>}
    </main>
  );
}
