/**
 * Unit coverage for the browser-side W3C trace helpers (#414).
 *
 * The wallet is the entry point of every traced flow, so a regression here
 * would silently break end-to-end correlation without failing any request.
 */

import {
  MAX_TRACEPARENT_LENGTH,
  TRACEPARENT_HEADER,
  childTraceContext,
  createTraceContext,
  createTraceId,
  createSpanId,
  formatTraceparent,
  outboundTraceparent,
  parseTraceparent,
} from "./traceContext";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

describe("traceContext", () => {
  it("exposes the canonical W3C header name", () => {
    expect(TRACEPARENT_HEADER).toBe("traceparent");
  });

  it("generates valid trace and span ids", () => {
    expect(createTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(createSpanId()).toMatch(/^[0-9a-f]{16}$/);
    expect(new Set(Array.from({ length: 100 }, () => createTraceId())).size).toBe(100);
  });

  it("round-trips a formatted context through the parser", () => {
    const trace = createTraceContext(true);
    const parsed = parseTraceparent(formatTraceparent(trace));

    expect(parsed).toEqual({ traceId: trace.traceId, spanId: trace.spanId, sampled: true });
  });

  it("preserves the unsampled flag", () => {
    expect(parseTraceparent(`00-${TRACE_ID}-${SPAN_ID}-00`)?.sampled).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["whitespace", "   "],
    ["wrong version", `01-${TRACE_ID}-${SPAN_ID}-01`],
    ["too few parts", `00-${TRACE_ID}-${SPAN_ID}`],
    ["all-zero trace id", `00-${"0".repeat(32)}-${SPAN_ID}-01`],
    ["all-zero span id", `00-${TRACE_ID}-${"0".repeat(16)}-01`],
    ["bad flags", `00-${TRACE_ID}-${SPAN_ID}-zz`],
    ["oversized", `00-${TRACE_ID}-${SPAN_ID}-01${"a".repeat(MAX_TRACEPARENT_LENGTH)}`],
  ])("rejects %s", (_label, raw) => {
    expect(parseTraceparent(raw as string | undefined)).toBeNull();
  });

  it("keeps the trace id and issues a new span for child spans", () => {
    const parent = createTraceContext(true);
    const child = childTraceContext(parent);

    expect(child.traceId).toBe(parent.traceId);
    expect(child.spanId).not.toBe(parent.spanId);
    expect(child.sampled).toBe(true);
  });

  it("continues a supplied trace for outbound calls", () => {
    const root = createTraceContext(true);
    const outbound = parseTraceparent(outboundTraceparent(root));

    expect(outbound?.traceId).toBe(root.traceId);
    expect(outbound?.spanId).not.toBe(root.spanId);
  });

  it("starts a root trace when none is supplied", () => {
    expect(parseTraceparent(outboundTraceparent())).not.toBeNull();
  });
});
