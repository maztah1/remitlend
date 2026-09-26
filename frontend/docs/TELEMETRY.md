# Privacy-Preserving User Journey Telemetry

This document describes the frontend user journey telemetry subsystem: what it
collects, how consent is enforced, how failures and retries behave, and the
resource bounds that keep it safe in production.

## Goals

- Understand aggregate user journeys (which screens are reached, in what order)
  without ever identifying an individual user.
- Be strictly additive: no change to deployed API contracts, persisted data, or
  existing consumers.
- Fail closed on consent and fail open on transport: telemetry must never block
  or break the product.

## Privacy model

Telemetry is **privacy-preserving by construction**:

- **No PII.** We never emit raw user IDs, wallet addresses, emails, IPs, device
  identifiers, or free-text. Events carry only a coarse, allow-listed `screen`
  name and a small set of enumerated `outcome` values.
- **Opt-in only.** Nothing is buffered or sent until the user has explicitly
  granted consent. Absence of consent is treated as denial.
- **No cross-session identity.** Events are not joined to any account. There is
  no persistent client identifier; a journey is only meaningful within a single
  in-memory session.
- **Allow-list, not deny-list.** Unknown screen names or outcome values are
  dropped rather than forwarded, so new call sites cannot accidentally leak
  data.

## Consent gating

Consent is resolved before any event is recorded:

1. The telemetry client reads the current consent state from the consent store.
2. If consent is `granted`, events are accepted into the buffer.
3. If consent is `denied` or `unknown`, the event is discarded immediately and
   no buffer entry is created.
4. If consent is revoked mid-session, the buffer is flushed-and-dropped: pending
   events are cleared and no further events are accepted until consent is
   re-granted.

Consent changes are observed reactively; there is no polling loop.

## Event shape

```ts
type JourneyEvent = {
  screen: AllowedScreen;   // allow-listed enum
  outcome: AllowedOutcome; // allow-listed enum
  ts: number;              // coarse timestamp (ms, bucketed)
};
```

Timestamps are bucketed to reduce fingerprinting. No other fields are
permitted; the serializer rejects anything outside this shape.

## Failure, retry, and stale-data behavior

- **Transport failure.** A failed flush is retried with bounded exponential
  backoff (base 500ms, factor 2, jittered) up to `MAX_RETRIES` attempts.
- **Retry exhaustion.** After `MAX_RETRIES`, the batch is dropped and a single
  structured error is logged. We do not persist failed batches across sessions.
- **Dependency failure.** If the transport dependency is unavailable, events
  continue to accumulate in the bounded buffer and are dropped oldest-first
  when full. Telemetry never throws into product code paths.
- **Stale data.** Buffered events older than `MAX_EVENT_AGE_MS` are discarded at
  flush time so we never emit stale journeys.
- **Authorization/consent failure.** Treated as denial: discard, no retry.

## Resource bounds

| Bound | Value | Purpose |
| --- | --- | --- |
| `MAX_BUFFER_SIZE` | 100 events | Cap in-memory usage |
| `MAX_RETRIES` | 3 | Bound retry storms |
| `MAX_EVENT_AGE_MS` | 5 min | Drop stale events |
| `SAMPLE_RATE` | 0.1 | Rate-limit volume |
| `FLUSH_INTERVAL_MS` | 30s | Bound flush frequency |

When the buffer is full, the oldest event is evicted. Sampling is applied at
record time so unsampled events never consume buffer space.

## Observability

- **Metrics:** `telemetry_events_recorded`, `telemetry_events_dropped`
  (labeled by reason: `no_consent`, `buffer_full`, `stale`, `retry_exhausted`),
  `telemetry_flush_duration_ms`.
- **Structured errors:** flush failures emit a structured error with a stable
  `code` and no user-identifying fields.
- **Audit events:** consent grant/revoke transitions are recorded locally for
  diagnostics; they contain no PII.

## Compatibility and rollout

- The subsystem is **additive**: it introduces no changes to existing API
  contracts, request/response shapes, or persisted data.
- It is **off by default** until consent is granted, so rollout requires no
  migration and is safe to ship behind the existing consent flow.
- Rollback is a no-op: disabling the client stops all recording and flushing;
  no server-side state needs to be reverted.

## Threat model notes

- **Re-identification via timing:** mitigated by timestamp bucketing and
  sampling.
- **Data exfiltration via new call sites:** mitigated by allow-listed enums and
  serializer rejection of unknown fields.
- **Consent bypass:** mitigated by resolving consent before buffering and by
  clearing the buffer on revocation.
- **Resource exhaustion:** mitigated by bounded buffer, bounded retries, and
  sampling.

## Verification

- Unit tests cover: consent granted/denied/unknown, revocation mid-session,
  buffer eviction, sampling, retry backoff and exhaustion, stale-event drop,
  and serializer rejection of non-allow-listed fields.
- Integration test covers the full journey: consent grant -> record -> flush ->
  transport failure -> retry -> success.
- Type checks and linting run against the telemetry module and its consumers.
