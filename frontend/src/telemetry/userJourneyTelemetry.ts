/**
 * Privacy-preserving user journey telemetry.
 *
 * Design goals (issue #342):
 * - Explicit opt-in / consent gating: nothing is buffered or flushed unless
 *   consent has been granted for the current session.
 * - No PII: raw user IDs, wallet addresses, emails, and free-text are never
 *   accepted or emitted. Only a coarse, allow-listed set of journey events
 *   with bounded, enumerated properties is recorded.
 * - Additive and non-breaking: this module is standalone and does not alter
 *   any deployed frontend contract, API consumer, or persisted data shape.
 * - Bounded resources: capped in-memory buffer, capped retry attempts with
 *   backoff, and sampling / rate limiting.
 * - Explicit failure paths: consent denial, dependency failure, and stale
 *   data are all handled without throwing into callers.
 */

export type JourneyEventName =
  | 'app_open'
  | 'route_view'
  | 'action_start'
  | 'action_success'
  | 'action_failure';

/**
 * Allow-listed, non-identifying properties. Values are constrained to
 * enumerated / bounded primitives so free-text and identifiers cannot leak.
 */
export interface JourneyEventProperties {
  /** Coarse route key, e.g. "dashboard" — never a full URL or query string. */
  route?: string;
  /** Coarse action key, e.g. "swap_submit" — never user input. */
  action?: string;
  /** Coarse outcome category, never an error message. */
  outcome?: 'ok' | 'error' | 'cancelled';
  /** Bounded duration bucket in milliseconds. */
  durationMs?: number;
}

export interface JourneyEvent {
  name: JourneyEventName;
  /** Milliseconds since epoch, set at record time. */
  ts: number;
  properties: JourneyEventProperties;
}

export interface TelemetryTransport {
  /**
   * Deliver a batch of events. Must resolve on success and reject on
   * dependency failure. Implementations must not throw synchronously.
   */
  send(events: JourneyEvent[]): Promise<void>;
}

export interface TelemetryConfig {
  transport: TelemetryTransport;
  /** Max events retained in memory before oldest are dropped. */
  maxBufferSize?: number;
  /** Max events per flush batch. */
  maxBatchSize?: number;
  /** Max delivery attempts per batch before the batch is dropped. */
  maxRetryAttempts?: number;
  /** Base backoff in ms; grows exponentially per attempt. */
  retryBaseDelayMs?: number;
  /** Sampling rate in [0, 1]; 1 records everything. */
  sampleRate?: number;
  /** Minimum ms between flushes to bound request rate. */
  minFlushIntervalMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional structured diagnostics sink (no PII). */
  onDiagnostic?: (diagnostic: TelemetryDiagnostic) => void;
}

export interface TelemetryDiagnostic {
  code:
    | 'consent_denied'
    | 'buffer_overflow'
    | 'flush_failed'
    | 'batch_dropped'
    | 'rate_limited';
  message: string;
  attempt?: number;
  droppedCount?: number;
}

const DEFAULT_MAX_BUFFER_SIZE = 100;
const DEFAULT_MAX_BATCH_SIZE = 20;
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_SAMPLE_RATE = 1;
const DEFAULT_MIN_FLUSH_INTERVAL_MS = 1000;

const ALLOWED_EVENT_NAMES: ReadonlySet<JourneyEventName> = new Set([
  'app_open',
  'route_view',
  'action_start',
  'action_success',
  'action_failure',
]);

const ALLOWED_OUTCOMES: ReadonlySet<NonNullable<JourneyEventProperties['outcome']>> =
  new Set(['ok', 'error', 'cancelled']);

/**
 * Sanitize properties down to the allow-list, dropping anything that could
 * carry PII (unknown keys, non-primitive values, oversized strings).
 */
function sanitizeProperties(
  input: JourneyEventProperties | undefined,
): JourneyEventProperties {
  const out: JourneyEventProperties = {};
  if (!input) {
    return out;
  }
  if (typeof input.route === 'string' && input.route.length <= 64) {
    out.route = input.route;
  }
  if (typeof input.action === 'string' && input.action.length <= 64) {
    out.action = input.action;
  }
  if (input.outcome && ALLOWED_OUTCOMES.has(input.outcome)) {
    out.outcome = input.outcome;
  }
  if (
    typeof input.durationMs === 'number' &&
    Number.isFinite(input.durationMs) &&
    input.durationMs >= 0
  ) {
    out.durationMs = Math.round(input.durationMs);
  }
  return out;
}

/**
 * Privacy-preserving user journey telemetry collector.
 *
 * Usage:
 *   const telemetry = createUserJourneyTelemetry({ transport });
 *   telemetry.setConsent(true);
 *   telemetry.record('route_view', { route: 'dashboard' });
 *   await telemetry.flush();
 */
export class UserJourneyTelemetry {
  private readonly transport: TelemetryTransport;
  private readonly maxBufferSize: number;
  private readonly maxBatchSize: number;
  private readonly maxRetryAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly sampleRate: number;
  private readonly minFlushIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onDiagnostic?: (diagnostic: TelemetryDiagnostic) => void;

  private consentGranted = false;
  private buffer: JourneyEvent[] = [];
  private lastFlushAt = 0;
  private flushing = false;

  constructor(config: TelemetryConfig) {
    if (!config || !config.transport || typeof config.transport.send !== 'function') {
      throw new Error('UserJourneyTelemetry requires a transport with a send() method');
    }
    this.transport = config.transport;
    this.maxBufferSize = config.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
    this.maxBatchSize = config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.maxRetryAttempts = config.maxRetryAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.sampleRate = clampSampleRate(config.sampleRate ?? DEFAULT_SAMPLE_RATE);
    this.minFlushIntervalMs = config.minFlushIntervalMs ?? DEFAULT_MIN_FLUSH_INTERVAL_MS;
    this.now = config.now ?? (() => Date.now());
    this.sleep = config.sleep ?? defaultSleep;
    this.onDiagnostic = config.onDiagnostic;
  }

  /**
   * Grant or revoke consent. Revoking consent immediately clears any buffered
   * events so nothing is retained or sent without an active opt-in.
   */
  setConsent(granted: boolean): void {
    this.consentGranted = granted;
    if (!granted) {
      this.buffer = [];
    }
  }

  isConsentGranted(): boolean {
    return this.consentGranted;
  }

  /**
   * Record a journey event. No-ops (with a diagnostic) when consent is absent
   * or the event name is not allow-listed. Never throws.
   */
  record(name: JourneyEventName, properties?: JourneyEventProperties): void {
    if (!this.consentGranted) {
      this.diagnostic({
        code: 'consent_denied',
        message: 'telemetry event dropped: consent not granted',
      });
      return;
    }
    if (!ALLOWED_EVENT_NAMES.has(name)) {
      this.diagnostic({
        code: 'consent_denied',
        message: 'telemetry event dropped: name not allow-listed',
      });
      return;
    }
    if (this.sampleRate < 1 && Math.random() >= this.sampleRate) {
      return;
    }

    this.buffer.push({
      name,
      ts: this.now(),
      properties: sanitizeProperties(properties),
    });

    if (this.buffer.length > this.maxBufferSize) {
      const overflow = this.buffer.length - this.maxBufferSize;
      this.buffer.splice(0, overflow);
      this.diagnostic({
        code: 'buffer_overflow',
        message: 'telemetry buffer overflow: oldest events dropped',
        droppedCount: overflow,
      });
    }
  }

  /** Number of events currently buffered (for diagnostics/tests). */
  pendingCount(): number {
    return this.buffer.length;
  }

  /**
   * Flush buffered events. Returns true when the batch was delivered, false
   * when it was skipped (no consent / empty / rate limited) or dropped after
   * exhausting retries. Never throws.
   */
  async flush(): Promise<boolean> {
    if (!this.consentGranted || this.buffer.length === 0) {
      return false;
    }
    if (this.flushing) {
      return false;
    }

    const nowMs = this.now();
    if (nowMs - this.lastFlushAt < this.minFlushIntervalMs) {
      this.diagnostic({
        code: 'rate_limited',
        message: 'telemetry flush skipped: rate limited',
      });
      return false;
    }

    this.flushing = true;
    const batch = this.buffer.slice(0, this.maxBatchSize);
    try {
      const delivered = await this.deliverWithRetry(batch);
      if (delivered) {
        this.buffer = this.buffer.slice(batch.length);
        this.lastFlushAt = this.now();
        return true;
      }
      // Exhausted retries: drop the batch to bound memory and avoid poison
      // events blocking the queue indefinitely.
      this.buffer = this.buffer.slice(batch.length);
      this.diagnostic({
        code: 'batch_dropped',
        message: 'telemetry batch dropped after exhausting retries',
        droppedCount: batch.length,
      });
      return false;
    } finally {
      this.flushing = false;
    }
  }

  private async deliverWithRetry(batch: JourneyEvent[]): Promise<boolean> {
    for (let attempt = 1; attempt <= this.maxRetryAttempts; attempt += 1) {
      try {
        await this.transport.send(batch);
        return true;
      } catch (error) {
        this.diagnostic({
          code: 'flush_failed',
          message: 'telemetry delivery attempt failed',
          attempt,
        });
        if (attempt < this.maxRetryAttempts) {
          await this.sleep(this.retryBaseDelayMs * 2 ** (attempt - 1));
        }
      }
    }
    return false;
  }

  private diagnostic(diagnostic: TelemetryDiagnostic): void {
    if (this.onDiagnostic) {
      try {
        this.onDiagnostic(diagnostic);
      } catch {
        // Diagnostics must never break telemetry or callers.
      }
    }
  }
}

function clampSampleRate(rate: number): number {
  if (!Number.isFinite(rate)) {
    return DEFAULT_SAMPLE_RATE;
  }
  return Math.min(1, Math.max(0, rate));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createUserJourneyTelemetry(
  config: TelemetryConfig,
): UserJourneyTelemetry {
  return new UserJourneyTelemetry(config);
}
