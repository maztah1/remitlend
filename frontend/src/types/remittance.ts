/**
 * Remittance domain types shared across the frontend.
 *
 * NOTE: These types describe the API/contract payload shape and MUST stay
 * compatible with existing API consumers, deployed contracts, and persisted
 * data. Progressive disclosure is a purely presentational concern: sensitive
 * fields remain part of the payload but are masked in the UI until the user
 * explicitly reveals them.
 */

export type RemittanceStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed';

/**
 * Fields on a remittance that are considered sensitive and therefore subject
 * to progressive disclosure (masked by default, revealed on explicit action).
 */
export const SENSITIVE_REMITTANCE_FIELDS = [
  'recipientName',
  'recipientAccount',
  'recipientBank',
  'reference',
] as const;

export type SensitiveRemittanceField =
  (typeof SENSITIVE_REMITTANCE_FIELDS)[number];

/**
 * A remittance record as returned by the API. The shape is unchanged; the
 * sensitive fields below are simply rendered behind progressive disclosure.
 */
export interface Remittance {
  id: string;
  status: RemittanceStatus;
  /** Amount in the smallest unit of `currency` (integer, authoritative). */
  amount: string;
  currency: string;
  createdAt: string;
  updatedAt?: string;
  /** Sensitive: recipient display name. */
  recipientName?: string;
  /** Sensitive: recipient account identifier. */
  recipientAccount?: string;
  /** Sensitive: recipient bank / institution. */
  recipientBank?: string;
  /** Sensitive: free-form payment reference. */
  reference?: string;
}

/**
 * Per-field disclosure state for a single remittance. Kept as a plain map so
 * it can be persisted in component state without changing the API shape.
 */
export type RemittanceDisclosureState = Partial<
  Record<SensitiveRemittanceField, boolean>
>;

/**
 * Bounded rendering limits for remittance lists. Prevents unbounded lists and
 * eager loading of sensitive data.
 */
export const REMITTANCE_PAGE_SIZE = 25;
export const REMITTANCE_MAX_PAGE_SIZE = 100;

/**
 * Clamp a requested page size into the supported, bounded range.
 */
export function clampRemittancePageSize(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return REMITTANCE_PAGE_SIZE;
  }
  const size = Math.floor(requested);
  if (size < 1) {
    return 1;
  }
  return Math.min(size, REMITTANCE_MAX_PAGE_SIZE);
}

/**
 * Mask a sensitive string value for display. Returns a fixed-width mask so the
 * rendered output does not leak the length of the underlying value.
 */
export function maskSensitiveValue(value?: string | null): string {
  if (value === undefined || value === null || value === '') {
    return '\u2014';
  }
  return '\u2022'.repeat(8);
}

/**
 * Resolve the display value for a sensitive field given the current disclosure
 * state. Masked by default; only revealed when explicitly toggled on.
 */
export function resolveSensitiveDisplay(
  field: SensitiveRemittanceField,
  remittance: Pick<Remittance, SensitiveRemittanceField>,
  disclosure: RemittanceDisclosureState,
): string {
  const raw = remittance[field];
  if (disclosure[field] === true) {
    return raw === undefined || raw === null || raw === '' ? '\u2014' : raw;
  }
  return maskSensitiveValue(raw);
}

/**
 * Toggle disclosure for a single sensitive field without mutating the input.
 */
export function toggleSensitiveField(
  disclosure: RemittanceDisclosureState,
  field: SensitiveRemittanceField,
): RemittanceDisclosureState {
  return { ...disclosure, [field]: disclosure[field] !== true };
}

/**
 * Multi-pool deposit workflow types.
 *
 * A guarded deposit fans a single user action out across one or more pools.
 * The payload shape is additive and backward compatible: existing single-pool
 * callers keep working, while multi-pool callers supply an explicit list of
 * allocations. All amounts are integer strings in the smallest unit of the
 * pool's currency (authoritative, never derived from display formatting).
 */

/**
 * A single pool allocation within a multi-pool deposit. `amount` is an integer
 * string in the smallest unit of `currency`.
 */
export interface DepositPoolAllocation {
  poolId: string;
  amount: string;
  currency: string;
}

/**
 * Lifecycle of a guarded multi-pool deposit. `partial` means at least one pool
 * succeeded and at least one failed; the workflow must surface this explicitly
 * rather than reporting a blanket success or failure.
 */
export type DepositWorkflowStatus =
  | 'idle'
  | 'validating'
  | 'submitting'
  | 'partial'
  | 'succeeded'
  | 'failed';

/**
 * Per-pool outcome, used for retry and rollback decisions. `retryable` marks
 * transient dependency failures that may be safely retried; authorization and
 * validation failures are never retryable.
 */
export interface DepositPoolResult {
  poolId: string;
  status: 'pending' | 'succeeded' | 'failed';
  /** Structured, machine-readable error code (never a raw message). */
  errorCode?: string;
  retryable?: boolean;
}

/**
 * Bounded limits for a multi-pool deposit. Prevents unbounded fan-out and
 * keeps resource usage predictable.
 */
export const DEPOSIT_MAX_POOLS = 10;
exexport const DEPOSIT_MAX_RETRIES = 3;

/**
 * Structured error codes for the deposit workflow. Kept as a closed union so
 * callers can branch on them without string matching.
 */
export type DepositErrorCode =
  | 'unauthorized'
  | 'invalid_amount'
  | 'invalid_pool'
  | 'duplicate_pool'
  | 'too_many_pools'
  | 'insufficient_balance'
  | 'dependency_failure'
  | 'stale_state';

/**
 * Validate a multi-pool deposit request before any network call is made.
 * Returns a structured error code on the first violation, or `null` when the
 * request is valid. Pure and side-effect free so it can be unit tested and
 * reused by the hook.
 */
export function validateDepositAllocations(
  allocations: readonly DepositPoolAllocation[],
  options?: { authorized?: boolean },
): DepositErrorCode | null {
  if (options?.authorized === false) {
    return 'unauthorized';
  }
  if (allocations.length === 0) {
    return 'invalid_pool';
  }
  if (allocations.length > DEPOSIT_MAX_POOLS) {
    return 'too_many_pools';
  }
  const seen = new Set<string>();
  for (const allocation of allocations) {
    if (!allocation.poolId) {
      return 'invalid_pool';
    }
    if (seen.has(allocation.poolId)) {
      return 'duplicate_pool';
    }
    seen.add(allocation.poolId);
    if (!isPositiveIntegerString(allocation.amount)) {
      return 'invalid_amount';
    }
  }
  return null;
}

/**
 * True when `value` is a strictly positive integer string. Rejects floats,
 * negatives, zero, empty strings, and non-numeric input so financial amounts
 * are never silently coerced.
 */
export function isPositiveIntegerString(value: string): boolean {
  return /^[0-9]+$/.test(value) && !/^0+$/.test(value);
}

/**
 * Decide whether a failed pool result may be retried. Only transient
 * dependency failures are retryable, and only while under the retry budget.
 */
export function canRetryPoolResult(
  result: DepositPoolResult,
  attempt: number,
): boolean {
  if (result.status !== 'failed' || result.retryable !== true) {
    return false;
  }
  return attempt < DEPOSIT_MAX_RETRIES;
}

/**
 * Aggregate per-pool results into an overall workflow status. A mix of
 * successes and failures is reported as `partial` so the UI never claims a
 * blanket success when some pools did not settle.
 */
export function aggregateDepositStatus(
  results: readonly DepositPoolResult[],
): DepositWorkflowStatus {
  if (results.length === 0) {
    return 'idle';
  }
  const succeeded = results.filter((r) => r.status === 'succeeded').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  if (failed === 0 && succeeded === results.length) {
    return 'succeeded';
  }
  if (succeeded > 0 && failed > 0) {
    return 'partial';
  }
  if (failed === results.length) {
    return 'failed';
  }
  return 'submitting';
}
