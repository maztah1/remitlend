import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  type TraceContext,
  formatTraceparent,
  outboundTraceparent,
  parseTraceparent,
} from './traceContext.js';

interface RequestContext {
  requestId: string;
  /**
   * W3C trace context for the current unit of work. Populated by
   * `traceContextMiddleware` for inbound HTTP requests, and explicitly by
   * background jobs (indexer passes, chain confirmation) that are not driven
   * by a request.
   */
  trace?: TraceContext;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

export const createRequestId = (): string => randomUUID();

/**
 * Runs `callback` with the given correlation id — and optional W3C trace
 * context — available to anything it calls, including nested async work.
 */
export const runWithRequestContext = <T>(
  requestId: string,
  callback: () => T,
  trace?: TraceContext,
): T => {
  return requestContextStorage.run(trace ? { requestId, trace } : { requestId }, callback);
};

export const getRequestId = (): string | undefined => {
  return requestContextStorage.getStore()?.requestId;
};

/** Returns the active W3C trace context, if any. */
export const getTraceContext = (): TraceContext | undefined => {
  return requestContextStorage.getStore()?.trace;
};

/** Returns the active trace id, if any (mirrors the logger's `traceId` field). */
export const getTraceId = (): string | undefined => getTraceContext()?.traceId;

/** Returns the active span id, if any. */
export const getSpanId = (): string | undefined => getTraceContext()?.spanId;

/**
 * Returns the active trace context as a `traceparent` header value. Used to
 * propagate correlation to outbound calls such as webhook deliveries and
 * chain RPC submissions.
 */
export const getTraceparent = (): string | undefined => {
  const trace = getTraceContext();
  return trace ? formatTraceparent(trace) : undefined;
};

/**
 * Returns a `traceparent` value for an outbound hop: a child span of the active
 * trace when there is one, otherwise a new root trace. Always usable, so call
 * sites can spread it into outbound headers unconditionally.
 */
export const getOutboundTraceparent = (): string => outboundTraceparent(getTraceContext());

export { parseTraceparent };
