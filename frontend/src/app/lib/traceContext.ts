/**
 * lib/traceContext.ts
 *
 * Minimal W3C Trace Context (https://www.w3.org/TR/trace-context/) client for
 * the browser. The wallet is the *start* of every money-moving flow: it signs
 * the transaction and then calls the RemitLend API, which propagates the same
 * trace through the indexer and the chain-confirmation poll. Sending a
 * `traceparent` from here is what makes a user-reported problem ("my repayment
 * shows as pending") traceable end to end.
 *
 * Deliberately dependency-free and bounded: values are validated and
 * length-capped before being sent, and only a fixed set of fields is ever
 * produced, so a hostile/legacy value can never be echoed onward.
 *
 * Failure semantics: every helper is total. There is no throwing path — a
 * missing Web Crypto API or malformed input results in a freshly generated
 * context, never a failed request.
 */

export const TRACEPARENT_HEADER = "traceparent";

/** Maximum length accepted for an inbound `traceparent` value. */
export const MAX_TRACEPARENT_LENGTH = 128;

const TRACE_CONTEXT_VERSION = "00";
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/;
const SPAN_ID_PATTERN = /^[0-9a-f]{16}$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

export interface TraceContext {
  /** 32 lowercase hex characters, never all-zero. */
  traceId: string;
  /** 16 lowercase hex characters for the span this hop created. */
  spanId: string;
  /** Sampled flag, inherited from upstream spans when present. */
  sampled: boolean;
}

const randomHex = (bytes: number): string => {
  const values = new Uint8Array(bytes);

  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(values);
  } else {
    // Non-cryptographic fallback for exotic environments (old jsdom, niche
    // webviews). Trace ids carry no security value — they are correlation
    // handles only — so degrading here must never block a request.
    for (let i = 0; i < bytes; i += 1) {
      values[i] = Math.floor(Math.random() * 256);
    }
  }

  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
};

export const createTraceId = (): string => randomHex(16);
export const createSpanId = (): string => randomHex(8);

/** Creates a fresh root trace context for a new user-initiated flow. */
export const createTraceContext = (sampled = true): TraceContext => ({
  traceId: createTraceId(),
  spanId: createSpanId(),
  sampled,
});

/** Derives a child span in the same trace (new span id, same sampled flag). */
export const childTraceContext = (parent: TraceContext): TraceContext => ({
  traceId: parent.traceId,
  spanId: createSpanId(),
  sampled: parent.sampled,
});

/** Serialises a context into a `traceparent` header value. */
export const formatTraceparent = (trace: TraceContext): string =>
  `${TRACE_CONTEXT_VERSION}-${trace.traceId}-${trace.spanId}-${trace.sampled ? "01" : "00"}`;

/**
 * Parses an inbound `traceparent` value, returning `null` for anything that is
 * not a usable version-00 header (malformed, oversized, all-zero ids, or an
 * unsupported version).
 */
export const parseTraceparent = (raw: string | null | undefined): TraceContext | null => {
  if (typeof raw !== "string") return null;

  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_TRACEPARENT_LENGTH) return null;

  const [version, traceId, parentSpanId, flags] = value.split("-");
  if (version !== TRACE_CONTEXT_VERSION) return null;
  if (!TRACE_ID_PATTERN.test(traceId ?? "") || traceId === ZERO_TRACE_ID) return null;
  if (!SPAN_ID_PATTERN.test(parentSpanId ?? "") || parentSpanId === ZERO_SPAN_ID) return null;
  if (!/^[0-9a-f]{2}$/i.test(flags ?? "")) return null;

  return {
    traceId,
    spanId: parentSpanId,
    sampled: (Number.parseInt(flags, 16) & 0x01) === 0x01,
  };
};

/**
 * Returns the `traceparent` value an outbound API call should carry. When the
 * caller already started a trace (e.g. a wallet confirmation dialog), pass it
 * in to continue that trace; otherwise a new root trace is created.
 */
export const outboundTraceparent = (current?: TraceContext): string =>
  formatTraceparent(current ? childTraceContext(current) : createTraceContext());
