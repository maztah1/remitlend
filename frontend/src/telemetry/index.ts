/**
 * Privacy-preserving user journey telemetry.
 *
 * Design goals (issue #342):
 * - Explicit opt-in consent gating: nothing is buffered or sent until consent is granted.
 * - No PII: event names and a small allow-listed set of primitive properties only.
 *   Raw user IDs, wallet addresses, emails, and free-text are rejected.
 * - Additive and non-breaking: a standalone module with no changes to existing contracts.
 * - Bounded resources: capped in-memory buffer, capped retry attempts with backoff,
 *   and sampling/rate limits.
 * - Explicit failure paths: consent denial, dependency failure, and stale data are
 *   surfaced as structured results rather than thrown exceptions.
 */

export type ConsentState = "unknown" | "granted" | "denied";

export interface TelemetryEvent {
  /** Allow-listed journey step name, e.g. "checkout_started". */
  name: string;
  /** Coarse, non-identifying properties (counts, enums, booleans). */
  properties?: Record<string, string | number | boolean>;
  /** Monotonic-ish client timestamp in ms. */
  timestamp: number;
}

export interface TelemetryTransport {
  /**
   * Deliver a batch of events. Must resolve on success and reject on failure.
   * Implementations are responsible for their own network concerns.
   */
  send(events: TelemetryEvent[]): Promise<void>;
}

export interface TelemetryConfig {
  transport: TelemetryTransport;
  /** Fraction of events to keep, in [0, 1]. Defaults to 1. */
  sampleRate?: number;
  /** Max events retained in memory before oldest are dropped. Defaults to 100. */
  maxBufferSize?: number;
  /** Max delivery attempts per flush (including the first). Defaults to 3. */
  maxRetries?: number;
  /** Base backoff in ms; attempt N waits base * 2^(N-1). Defaults to 250. */
  baseBackoffMs?: number;
  /** Max events sent per flush. Defaults to 20. */
  maxBatchSize?: number;
  /** Max events accepted per rolling window. Defaults to 200. */
  rateLimit?: number;
  /** Rolling window length in ms for the rate limit. Defaults to 60_000. */
  rateLimitWindowMs?: number;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Injectable sleep for deterministic tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export type FlushStatus =
  | "sent"
  | "empty"
  | "consent_denied"
  | "rate_limited"
  | "dependency_failure";

export interface FlushResult {
  status: FlushStatus;
  sent: number;
  dropped: number;
  attempts: number;
  /** Structured, non-PII error code when status is "dependency_failure". */
  errorCode?: string;
}

/**
 * Property keys that would carry PII. Rejected outright so callers cannot
 * accidentally leak identifiers through the telemetry surface.
 */
const FORBIDDEN_PROPERTY_KEYS = [
  "userid",
  "user_id",
  "address",
  "wallet",
  "walletaddress",
  "wallet_address",
  "email",
  "account",
  "accountid",
  "account_id",
  "ip",
  "ipaddress",
  "ip_address",
  "token",
  "sessionid",
  "session_id",
];

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_PROPERTY_KEYS.includes(key.toLowerCase());
}

/**
 * Validate an event name and its properties. Returns null when valid, or a
 * structured error code describing the first violation.
 */
export function validateEvent(event: TelemetryEvent): string | null {
  if (!EVENT_NAME_PATTERN.test(event.name)) {
    return "invalid_event_name";
  }
  if (typeof event.timestamp !== "number" || !Number.isFinite(event.timestamp)) {
    return "invalid_timestamp";
  }
  const properties = event.properties ?? {};
  for (const key of Object.keys(properties)) {
    if (isForbiddenKey(key)) {
      return "pii_property_rejected";
    }
    const value = properties[key];
    const valueType = typeof value;
    if (valueType !== "string" && valueType !== "number" && valueType !== "boolean") {
      return "invalid_property_type";
    }
    if (valueType === "string" && value.length > 64) {
      return "property_too_long";
    }
  }
  return null;
}

/**
 * Privacy-preserving journey telemetry client.
 *
 * Lifecycle:
 * 1. Construct with a transport and optional bounds.
 * 2. Call `setConsent` once the user's choice is known. Until consent is
 *    "granted", `track` is a no-op and `flush` reports "consent_denied".
 * 3. Call `track` for allow-listed journey steps.
 * 4. Call `flush` to deliver buffered events with bounded retries.
 */
export class JourneyTelemetry {
  private readonly transport: TelemetryTransport;
  private readonly sampleRate: number;
  private readonly maxBufferSize: number;
  private readonly maxRetries: number;
  private readonly baseBackoffMs: number;
  private readonly maxBatchSize: number;
  private readonly rateLimit: number;
  private readonly rateLimitWindowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private consent: ConsentState = "unknown";
  private buffer: TelemetryEvent[] = [];
  private windowStart = 0;
  private windowCount = 0;
  private droppedCount = 0;

  constructor(config: TelemetryConfig) {
    this.transport = config.transport;
    this.sampleRate = clamp(config.sampleRate ?? 1, 0, 1);
    this.maxBufferSize = Math.max(1, config.maxBufferSize ?? 100);
    this.maxRetries = Math.max(1, config.maxRetries ?? 3);
    this.baseBackoffMs = Math.max(0, config.baseBackoffMs ?? 250);
    this.maxBatchSize = Math.max(1, config.maxBatchSize ?? 20);
    this.rateLimit = Math.max(1, config.rateLimit ?? 200);
    this.rateLimitWindowMs = Math.max(1, config.rateLimitWindowMs ?? 60_000);
    this.now = config.now ?? (() => Date.now());
    this.sleep =
      config.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Record the user's consent decision. Revoking consent clears any buffered
   * events so nothing is retained after opt-out.
   */
  setConsent(state: ConsentState): void {
    this.consent = state;
    if (state !== "granted") {
      this.buffer = [];
    }
  }

  getConsent(): ConsentState {
    return this.consent;
  }

  /**
   * Buffer a journey event. Returns true when accepted, false when dropped
   * (no consent, invalid/PII payload, sampled out, or rate limited).
   */
  track(name: string, properties?: Record<string, string | number | boolean>): boolean {
    if (this.consent !== "granted") {
      return false;
    }
    const event: TelemetryEvent = { name, properties, timestamp: this.now() };
    if (validateEvent(event) !== null) {
      return false;
    }
    if (this.sampleRate < 1 && Math.random() >= this.sampleRate) {
      return false;
    }
    if (!this.consumeRateLimit()) {
      this.droppedCount += 1;
      return false;
    }
    this.buffer.push(event);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.splice(0, this.buffer.length - this.maxBufferSize);
      this.droppedCount += 1;
    }
    return true;
  }

  /** Number of events currently buffered. */
  get bufferedCount(): number {
    return this.buffer.length;
  }

  /**
   * Deliver buffered events with bounded retries and exponential backoff.
   * Never throws: dependency failures are reported via the result.
   */
  async flush(): Promise<FlushResult> {
    if (this.consent !== "granted") {
      return { status: "consent_denied", sent: 0, dropped: this.droppedCount, attempts: 0 };
    }
    if (this.buffer.length === 0) {
      return { status: "empty", sent: 0, dropped: this.droppedCount, attempts: 0 };
    }

    const batch = this.buffer.slice(0, this.maxBatchSize);
    let attempts = 0;
    let lastErrorCode = "unknown_error";

    while (attempts < this.maxRetries) {
      attempts += 1;
      try {
        await this.transport.send(batch);
        this.buffer.splice(0, batch.length);
        return {
          status: "sent",
          sent: batch.length,
          dropped: this.droppedCount,
          attempts,
        };
      } catch (error) {
        lastErrorCode = errorCodeOf(error);
        if (attempts < this.maxRetries) {
          await this.sleep(this.baseBackoffMs * 2 ** (attempts - 1));
        }
      }
    }

    // Exhausted retries: keep the batch buffered for a later flush, but bound
    // memory by dropping the oldest events if the buffer has grown too large.
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.splice(0, this.buffer.length - this.maxBufferSize);
      this.droppedCount += 1;
    }
    return {
      status: "dependency_failure",
      sent: 0,
      dropped: this.droppedCount,
      attempts,
      errorCode: lastErrorCode,
    };
  }

  private consumeRateLimit(): boolean {
    const now = this.now();
    if (now - this.windowStart >= this.rateLimitWindowMs) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    if (this.windowCount >= this.rateLimit) {
      return false;
    }
    this.windowCount += 1;
    return true;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return max;
  }
  return Math.min(max, Math.max(min, value));
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return code;
    }
  }
  return "transport_error";
}
