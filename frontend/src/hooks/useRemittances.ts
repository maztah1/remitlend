import { useCallback, useMemo, useRef, useState } from 'react';

/**
 * Remittance record as returned by the API. The shape is intentionally left
 * open so we stay compatible with existing API consumers and persisted data.
 */
export interface Remittance {
  id: string;
  [key: string]: unknown;
}

/**
 * Fields that are considered sensitive and must be masked by default.
 * Progressive disclosure: these are only revealed after an explicit user
 * action (toggle/expand) for a specific remittance.
 */
export const SENSITIVE_REMITTANCE_FIELDS = [
  'accountNumber',
  'routingNumber',
  'iban',
  'swift',
  'recipientName',
  'recipientEmail',
  'recipientPhone',
  'address',
] as const;

export type SensitiveRemittanceField = (typeof SENSITIVE_REMITTANCE_FIELDS)[number];

const MASK = '••••••••';

/**
 * Bounded rendering: never eagerly load or render more than this many
 * remittances at once. Keeps resource usage predictable for large datasets.
 */
export const MAX_VISIBLE_REMITTANCES = 50;

function isSensitiveField(key: string): key is SensitiveRemittanceField {
  return (SENSITIVE_REMITTANCE_FIELDS as readonly string[]).includes(key);
}

/**
 * Redact sensitive fields on a single remittance. Non-sensitive fields are
 * passed through untouched so existing consumers keep working.
 */
export function redactRemittance(remittance: Remittance): Remittance {
  const redacted: Remittance = { ...remittance };
  for (const key of Object.keys(redacted)) {
    if (isSensitiveField(key)) {
      redacted[key] = MASK;
    }
  }
  return redacted;
}

/**
 * Redact sensitive fields across a bounded slice of remittances.
 */
export function redactRemittances(remittances: Remittance[]): Remittance[] {
  return remittances.slice(0, MAX_VISIBLE_REMITTANCES).map(redactRemittance);
}

/**
 * A single pool target for a guarded multi-pool deposit. `amount` is a
 * decimal string so financial arithmetic stays exact and never relies on
 * floating point. `poolId` must reference a pool the caller is authorized
 * to deposit into.
 */
export interface DepositPoolTarget {
  poolId: string;
  amount: string;
}

/**
 * A deposit request. `idempotencyKey` makes retries safe: the same key must
 * never be applied twice, so a retried request cannot double-deposit.
 */
export interface DepositRequest {
  idempotencyKey: string;
  targets: DepositPoolTarget[];
}

export type DepositStatus =
  | 'idle'
  | 'validating'
  | 'submitting'
  | 'success'
  | 'error';

/**
 * Structured, machine-readable deposit error. `code` is stable so callers
 * and observability tooling can branch on it without parsing messages.
 */
export interface DepositError {
  code:
    | 'EMPTY_TARGETS'
    | 'TOO_MANY_TARGETS'
    | 'DUPLICATE_POOL'
    | 'INVALID_AMOUNT'
    | 'UNAUTHORIZED_POOL'
    | 'MISSING_IDEMPOTENCY_KEY'
    | 'SUBMIT_FAILED';
  message: string;
  poolId?: string;
}

/**
 * Bounded resource usage: a single deposit may fan out to at most this many
 * pools. Prevents unbounded loops and gas/API amplification.
 */
export const MAX_DEPOSIT_POOLS = 10;

/**
 * Decimal string with up to 18 fractional digits, strictly positive.
 * Kept as a string to preserve exact financial arithmetic.
 */
const AMOUNT_PATTERN = /^\d+(\.\d{1,18})?$/;

function isValidAmount(amount: string): boolean {
  if (!AMOUNT_PATTERN.test(amount)) return false;
  // Reject zero and any value that is effectively zero.
  return /[1-9]/.test(amount);
}

/**
 * Pure validation for a deposit request. Returns the first structured error
 * found, or null when the request is valid. Kept pure so it can be unit
 * tested and reused by callers before hitting the network.
 */
export function validateDepositRequest(
  request: DepositRequest,
  authorizedPoolIds: readonly string[],
): DepositError | null {
  if (!request.idempotencyKey) {
    return { code: 'MISSING_IDEMPOTENCY_KEY', message: 'An idempotency key is required.' };
  }
  if (request.targets.length === 0) {
    return { code: 'EMPTY_TARGETS', message: 'At least one pool target is required.' };
  }
  if (request.targets.length > MAX_DEPOSIT_POOLS) {
    return {
      code: 'TOO_MANY_TARGETS',
      message: `A deposit may target at most ${MAX_DEPOSIT_POOLS} pools.`,
    };
  }
  const seen = new Set<string>();
  for (const target of request.targets) {
    if (!target.poolId || seen.has(target.poolId)) {
      return {
        code: 'DUPLICATE_POOL',
        message: 'Each pool may only be targeted once per deposit.',
        poolId: target.poolId,
      };
    }
    seen.add(target.poolId);
    if (!authorizedPoolIds.includes(target.poolId)) {
      return {
        code: 'UNAUTHORIZED_POOL',
        message: 'You are not authorized to deposit into this pool.',
        poolId: target.poolId,
      };
    }
    if (!isValidAmount(target.amount)) {
      return {
        code: 'INVALID_AMOUNT',
        message: 'Amount must be a positive decimal string.',
        poolId: target.poolId,
      };
    }
  }
  return null;
}

/**
 * Submits a validated deposit request. Injected so the hook stays decoupled
 * from any specific transport and can be tested with a fake.
 */
export type DepositSubmitter = (request: DepositRequest) => Promise<void>;

export interface UseRemittancesResult {
  /** Remittances with sensitive fields masked unless explicitly revealed. */
  remittances: Remittance[];
  /** Ids of remittances whose sensitive data has been revealed. */
  revealedIds: string[];
  /** Whether a given remittance's sensitive data is currently revealed. */
  isRevealed: (id: string) => boolean;
  /** Explicitly reveal sensitive data for a single remittance. */
  reveal: (id: string) => void;
  /** Re-mask sensitive data for a single remittance. */
  conceal: (id: string) => void;
  /** Toggle disclosure for a single remittance. */
  toggle: (id: string) => void;
  /** Re-mask every remittance (e.g. on navigation or logout). */
  concealAll: () => void;
  /** Current status of the guarded multi-pool deposit workflow. */
  depositStatus: DepositStatus;
  /** Structured error from the most recent deposit attempt, if any. */
  depositError: DepositError | null;
  /**
   * Validate and submit a guarded multi-pool deposit. Retries with the same
   * idempotency key are safe and never double-apply. Returns the structured
   * error on failure, or null on success.
   */
  deposit: (request: DepositRequest) => Promise<DepositError | null>;
  /** Reset deposit status/error back to idle (e.g. after dismissal). */
  resetDeposit: () => void;
}

/**
 * Progressive disclosure hook for sensitive remittance data, extended with a
 * guarded multi-pool deposit workflow.
 *
 * Sensitive fields are masked by default and only revealed through an
 * explicit user action. Rendering is bounded to MAX_VISIBLE_REMITTANCES.
 * Deposits are validated (authorization, bounds, exact amounts, idempotency)
 * before submission and expose structured errors for observability.
 */
export function useRemittances(
  input: Remittance[] = [],
  options: {
    authorizedPoolIds?: readonly string[];
    submitDeposit?: DepositSubmitter;
  } = {},
): UseRemittancesResult {
  const [revealedIds, setRevealedIds] = useState<string[]>([]);
  const [depositStatus, setDepositStatus] = useState<DepositStatus>('idle');
  const [depositError, setDepositError] = useState<DepositError | null>(null);

  const authorizedPoolIds = options.authorizedPoolIds ?? [];
  const submitDeposit = options.submitDeposit;

  // Tracks idempotency keys already applied so retries cannot double-deposit.
  const appliedKeys = useRef<Set<string>>(new Set());

  const bounded = useMemo(
    () => input.slice(0, MAX_VISIBLE_REMITTANCES),
    [input],
  );

  const remittances = useMemo(
    () =>
      bounded.map((remittance) =>
        revealedIds.includes(remittance.id)
          ? remittance
          : redactRemittance(remittance),
      ),
    [bounded, revealedIds],
  );

  const isRevealed = useCallback(
    (id: string) => revealedIds.includes(id),
    [revealedIds],
  );

  const reveal = useCallback((id: string) => {
    if (!id) return;
    setRevealedIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  }, []);

  const conceal = useCallback((id: string) => {
    setRevealedIds((prev) => prev.filter((existing) => existing !== id));
  }, []);

  const toggle = useCallback((id: string) => {
    if (!id) return;
    setRevealedIds((prev) =>
      prev.includes(id) ? prev.filter((existing) => existing !== id) : [...prev, id],
    );
  }, []);

  const concealAll = useCallback(() => {
    setRevealedIds([]);
  }, []);

  const resetDeposit = useCallback(() => {
    setDepositStatus('idle');
    setDepositError(null);
  }, []);

  const deposit = useCallback(
    async (request: DepositRequest): Promise<DepositError | null> => {
      setDepositStatus('validating');
      setDepositError(null);

      const validationError = validateDepositRequest(request, authorizedPoolIds);
      if (validationError) {
        setDepositError(validationError);
        setDepositStatus('error');
        return validationError;
      }

      // Idempotency guard: a retried request with an already-applied key is a
      // no-op success rather than a second deposit.
      if (appliedKeys.current.has(request.idempotencyKey)) {
        setDepositStatus('success');
        return null;
      }

      if (!submitDeposit) {
        const error: DepositError = {
          code: 'SUBMIT_FAILED',
          message: 'No deposit submitter is configured.',
        };
        setDepositError(error);
        setDepositStatus('error');
        return error;
      }

      setDepositStatus('submitting');
      try {
        await submitDeposit(request);
        appliedKeys.current.add(request.idempotencyKey);
        setDepositStatus('success');
        return null;
      } catch (cause) {
        const error: DepositError = {
          code: 'SUBMIT_FAILED',
          message:
            cause instanceof Error && cause.message
              ? cause.message
              : 'Deposit submission failed.',
        };
        setDepositError(error);
        setDepositStatus('error');
        return error;
      }
    },
    [authorizedPoolIds, submitDeposit],
  );

  return {
    remittances,
    revealedIds,
    isRevealed,
    reveal,
    conceal,
    toggle,
    concealAll,
    depositStatus,
    depositError,
    deposit,
    resetDeposit,
  };
}

export default useRemittances;
