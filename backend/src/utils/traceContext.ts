/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/) helpers.
 *
 * RemitLend carries a `traceparent` header across every hop of a money-moving
 * flow so that a single user action — a wallet signature, the API call that
 * submits it, the indexer pass that observes the resulting event, and the
 * chain-confirmation poll that reports the final status — can be stitched
 * together in logs, metrics, and support tooling.
 *
 * The format is intentionally implemented here instead of pulling in an
 * OpenTelemetry SDK: the backend is the only component that must speak the
 * wire format, and a dependency-free parser keeps the trust boundary explicit.
 *
 * Wire format (version 00):
 *
 *     traceparent: <version>-<trace-id>-<parent-id>-<trace-flags>
 *                  00        -32 hex   -16 hex   -2 hex
 *
 * Failure semantics (fail-soft, never fail-closed):
 *   A malformed, oversized, all-zero, or version-mismatched `traceparent` is
 *   *not* rejected at the HTTP layer. The request proceeds with a freshly
 *   generated trace and the outcome is recorded as `invalid` in the
 *   `trace_context_requests_total` metric, so instrumentation problems can
 *   never take the API down.
 *
 * Bounded resource usage: incoming `traceparent`/`tracestate` values are
 * length-capped before parsing (and `tracestate` is capped on the way out
 * too), so an attacker cannot force unbounded parsing or log amplification
 * through these headers. Only a small, fixed set of fields is ever parsed or
 * echoed back, and metric labels are drawn from a closed set of outcomes —
 * never from header content — so cardinality stays bounded.
 */

import { randomBytes } from 'node:crypto';

/** Canonical header names, matching the W3C specification exactly. */
export const TRACEPARENT_HEADER = 'traceparent';
export const TRACESTATE_HEADER = 'tracestate';

/**
 * Maximum accepted length of an incoming `traceparent` value. The spec fixes a
 * valid version-00 value at 55 characters; the slack allows a longer (but
 * still bounded) future version prefix before we reject and regenerate.
 */
export const MAX_TRACEPARENT_LENGTH = 128;

/**
 * Maximum accepted length of an incoming `tracestate` value, per the W3C
 * specification ("vendors MUST accept at least 512 characters").
 */
export const MAX_TRACESTATE_LENGTH = 512;

/** Version this implementation emits. */
export const TRACE_CONTEXT_VERSION = '00';

/** Sampled flag bit (bit 0 of the trace-flags byte). */
const SAMPLED_FLAG = 0x01;

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const VERSION_PATTERN = /^[0-9a-f]{2}$/;
const FLAGS_PATTERN = /^[0-9a-f]{2}$/;
const TRACESTATE_PATTERN = /^[\x20-\x7e]*$/;

const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

export interface TraceContext {
  /** 32 lowercase hex characters, never all-zero. */
  traceId: string;
  /** 16 lowercase hex characters for the span this component created. */
  spanId: string;
  /** Whether the trace should be exported by sampling-aware consumers. */
  sampled: boolean;
}

export interface ParsedTraceparent extends TraceContext {
  /** Version field of the parsed header. */
  version: string;
  /** Span id the upstream caller created — the parent of our span. */
  parentSpanId: string;
}

/** Generates a new, spec-valid trace id (128 bits of CSPRNG output). */
export const createTraceId = (): string => randomBytes(16).toString('hex');

/** Generates a new, spec-valid span id (64 bits of CSPRNG output). */
export const createSpanId = (): string => randomBytes(8).toString('hex');

/**
 * Reads the configured sampling rate for *root* traces (requests that arrive
 * without a `traceparent`). Values outside [0, 1] fall back to 1 so a typo can
 * never silently disable all tracing.
 */
const getRootSampleRate = (): number => {
  const raw = process.env.TRACE_CONTEXT_SAMPLE_RATE;
  if (raw === undefined || raw.trim() === '') return 1;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return 1;
  }

  return parsed;
};

/** Decides the sampled flag for a brand-new root trace. */
export const decideRootSampling = (random: () => number = Math.random): boolean =>
  random() < getRootSampleRate();

/**
 * Parses and validates an incoming `traceparent` header value.
 *
 * Returns `null` for anything that is not a usable version-00 header —
 * missing, oversized, malformed, all-zero ids, or an unsupported version —
 * so callers can fall back to generating a fresh trace.
 */
export const parseTraceparent = (raw: string | null | undefined): ParsedTraceparent | null => {
  if (typeof raw !== 'string') return null;

  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_TRACEPARENT_LENGTH) return null;

  const parts = value.split('-');
  if (parts.length !== 4) return null;

  // `parts.length === 4` is checked above; the defaults satisfy
  // `noUncheckedIndexedAccess` without loosening the pattern checks below.
  const version = parts[0] ?? '';
  const traceId = parts[1] ?? '';
  const parentSpanId = parts[2] ?? '';
  const flags = parts[3] ?? '';

  if (!VERSION_PATTERN.test(version) || !FLAGS_PATTERN.test(flags)) return null;

  // This implementation only understands version 00. Higher versions are
  // required to be parsed leniently by the spec, but since we do not need the
  // extra fields we treat them as unsupported rather than guessing at layout.
  if (version !== TRACE_CONTEXT_VERSION) return null;

  if (!TRACE_ID_PATTERN.test(traceId) || traceId === ZERO_TRACE_ID) return null;
  if (!SPAN_ID_PATTERN.test(parentSpanId) || parentSpanId === ZERO_SPAN_ID) return null;

  const sampled = (Number.parseInt(flags, 16) & SAMPLED_FLAG) === SAMPLED_FLAG;

  return { version, traceId, parentSpanId, spanId: parentSpanId, sampled };
};

/** Serialises a trace context back into a `traceparent` header value. */
export const formatTraceparent = (trace: TraceContext, version = TRACE_CONTEXT_VERSION): string =>
  `${version}-${trace.traceId}-${trace.spanId}-${trace.sampled ? '01' : '00'}`;

/** Creates a root trace context (new trace id + new span id). */
export const createTraceContext = (
  options: { sampled?: boolean; random?: () => number } = {},
): TraceContext => ({
  traceId: createTraceId(),
  spanId: createSpanId(),
  sampled: options.sampled ?? decideRootSampling(options.random),
});

/**
 * Derives a child span within an existing trace, preserving the trace id and
 * sampled decision while minting a new span id for the next hop.
 */
export const childTraceContext = (parent: TraceContext): TraceContext => ({
  traceId: parent.traceId,
  spanId: createSpanId(),
  sampled: parent.sampled,
});

/**
 * Returns the trace context an outbound hop should use: a child of the active
 * context when one exists, otherwise a new root trace.
 */
export const outboundTraceContext = (current?: TraceContext): TraceContext =>
  current ? childTraceContext(current) : createTraceContext();

/**
 * Returns the `traceparent` header value for an outbound call. Always usable —
 * callers can spread it into headers unconditionally.
 */
export const outboundTraceparent = (current?: TraceContext): string =>
  formatTraceparent(outboundTraceContext(current));

/** Normalises an incoming `tracestate` value for safe pass-through. */
export const sanitizeTracestate = (raw: string | null | undefined): string | undefined => {
  if (typeof raw !== 'string') return undefined;

  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_TRACESTATE_LENGTH) return undefined;
  if (!TRACESTATE_PATTERN.test(value)) return undefined;

  return value;
};
