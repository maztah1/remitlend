/**
 * W3C trace-context middleware.
 *
 * Resolves the inbound `traceparent` header into a request-scoped span so that
 * every log line, downstream call, and indexer/chain-confirmation handoff can
 * be correlated back to the originating wallet action.
 *
 * Behaviour:
 *   - Valid `traceparent`  → continue that trace with a new child span.
 *   - Missing header       → start a new root trace (subject to
 *                            `TRACE_CONTEXT_SAMPLE_RATE`, default 1).
 *   - Invalid/oversized    → start a new root trace and count the request as
 *                            `invalid` (fail-soft: the request still runs).
 *   - Valid `tracestate`   → echoed back unchanged (bounded) so upstream
 *                            vendors keep their state across the hop.
 *
 * The resolved span is published on `req.traceId` / `req.spanId`, echoed to
 * the client via the `traceparent` response header, and stored in the shared
 * async-local request context (`../utils/requestContext.js`) so the logger and
 * outbound call sites need no extra plumbing.
 */

import type { NextFunction, Request, Response } from 'express';
import {
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  type TraceContext,
  childTraceContext,
  createTraceContext,
  formatTraceparent,
  parseTraceparent,
  sanitizeTracestate,
} from '../utils/traceContext.js';
import { createRequestId, runWithRequestContext } from '../utils/requestContext.js';
import { traceContextCounter } from './metrics.js';
import logger from '../utils/logger.js';

declare module 'express' {
  interface Request {
    traceId?: string;
    spanId?: string;
    /** The resolved `traceparent` value for this request, set by this middleware. */
    traceparent?: string;
  }
}

export const traceContextMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const incoming = req.header(TRACEPARENT_HEADER);
  const parsed = parseTraceparent(incoming);
  const requestId = req.requestId ?? createRequestId();

  let trace: TraceContext;
  let source: 'incoming' | 'generated' | 'invalid';

  if (parsed) {
    // Preserve the trace id and sampling decision, but mint our own span id so
    // the API hop is distinguishable from the wallet hop that called it.
    trace = childTraceContext(parsed);
    source = 'incoming';
  } else {
    trace = createTraceContext();
    source = incoming === undefined ? 'generated' : 'invalid';

    if (source === 'invalid') {
      // Header content is deliberately not included in the log line: it is
      // caller-controlled and would otherwise be an unbounded log sink.
      logger.withContext().warn('Rejected invalid traceparent header; starting a new trace', {
        module: 'trace-context',
        action: 'reject-incoming',
        headerLength: incoming?.length,
      });
    }
  }

  req.traceId = trace.traceId;
  req.spanId = trace.spanId;
  req.traceparent = formatTraceparent(trace);

  res.setHeader(TRACEPARENT_HEADER, formatTraceparent(trace));

  const tracestate = sanitizeTracestate(req.header(TRACESTATE_HEADER));
  if (tracestate) {
    res.setHeader(TRACESTATE_HEADER, tracestate);
  }

  traceContextCounter.inc({ source });

  runWithRequestContext(requestId, () => next(), trace);
};
