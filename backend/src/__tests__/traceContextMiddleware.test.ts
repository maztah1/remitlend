/**
 * Integration coverage for the trace-context middleware (#414).
 *
 * Verifies the request-visible contract (headers echoed to clients), that an
 * incoming wallet/gateway trace is continued rather than replaced, that a
 * malformed header degrades gracefully instead of failing the request, and
 * that a handler's async work (including asynchronous logging) observes the
 * same trace id — the property the indexer and chain-confirmation handoffs
 * depend on.
 */

import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';
import { requestIdMiddleware } from '../middleware/requestId.js';
import { traceContextMiddleware } from '../middleware/traceContext.js';
import {
  getTraceId,
  getTraceparent,
  runWithRequestContext,
  createRequestId,
} from '../utils/requestContext.js';
import { parseTraceparent } from '../utils/traceContext.js';
import logger from '../utils/logger.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';
const INCOMING = `00-${TRACE_ID}-${SPAN_ID}-01`;

const buildApp = () => {
  const app = express();
  app.use(requestIdMiddleware);
  app.use(traceContextMiddleware);
  app.get('/trace', async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    res.json({ traceId: getTraceId(), traceparent: getTraceparent() });
  });
  app.get('/boom', () => {
    throw new Error('handler failure');
  });
  app.use(
    (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ message: error.message });
    },
  );
  return app;
};

describe('trace context middleware', () => {
  const app = buildApp();

  it('generates a traceparent for requests without one and echoes it back', async () => {
    const res = await request(app).get('/trace');

    expect(res.status).toBe(200);
    const header = res.headers['traceparent'] as string;
    expect(header).toBeDefined();

    const parsed = parseTraceparent(header);
    expect(parsed).not.toBeNull();
    expect(parsed?.sampled).toBe(true);
    // The handler observed the same span that was returned to the client.
    expect(res.body.traceparent).toBe(header);
    expect(res.body.traceId).toBe(parsed?.traceId);
  });

  it('continues an incoming trace with a new span id', async () => {
    const res = await request(app).get('/trace').set('traceparent', INCOMING);

    expect(res.status).toBe(200);
    const parsed = parseTraceparent(res.headers['traceparent'] as string);
    expect(parsed?.traceId).toBe(TRACE_ID);
    // The parent span id must not be reused for the API hop.
    expect(parsed?.spanId).not.toBe(SPAN_ID);
    expect(res.body.traceId).toBe(TRACE_ID);
  });

  it('preserves the unsampled flag from the upstream trace', async () => {
    const res = await request(app).get('/trace').set('traceparent', `00-${TRACE_ID}-${SPAN_ID}-00`);

    expect(parseTraceparent(res.headers['traceparent'] as string)?.sampled).toBe(false);
  });

  it('echoes a bounded tracestate value and drops malformed ones', async () => {
    const kept = await request(app)
      .get('/trace')
      .set('traceparent', INCOMING)
      .set('tracestate', 'congo=t61rcWkgMzE');
    expect(kept.headers['tracestate']).toBe('congo=t61rcWkgMzE');

    const dropped = await request(app)
      .get('/trace')
      .set('traceparent', INCOMING)
      .set('tracestate', 'a'.repeat(600));
    expect(dropped.headers['tracestate']).toBeUndefined();
  });

  it('degrades gracefully on a malformed traceparent instead of failing the request', async () => {
    const warnSpy = jest.spyOn(logger, 'warn');
    const res = await request(app).get('/trace').set('traceparent', 'not-a-traceparent');

    expect(res.status).toBe(200);
    const parsed = parseTraceparent(res.headers['traceparent'] as string);
    expect(parsed).not.toBeNull();
    expect(parsed?.traceId).not.toBe(TRACE_ID);
    warnSpy.mockRestore();
  });

  it('keeps tracing working when the handler throws (dependency-failure path)', async () => {
    const res = await request(app).get('/boom').set('traceparent', INCOMING);

    expect(res.status).toBe(500);
    expect(parseTraceparent(res.headers['traceparent'] as string)?.traceId).toBe(TRACE_ID);
  });

  it('does not leak trace context across concurrent requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 25 }, () => request(app).get('/trace')),
    );

    const traceIds = responses.map((response) => response.body.traceId as string);
    expect(new Set(traceIds).size).toBe(25);

    responses.forEach((response) => {
      expect((response.headers['traceparent'] as string).includes(response.body.traceId)).toBe(
        true,
      );
    });
  });

  it('exposes no ambient trace when running outside a request context', () => {
    expect(getTraceId()).toBeUndefined();
    expect(getTraceparent()).toBeUndefined();
  });

  it('lets background jobs start their own traced unit of work', () => {
    const correlationId = `indexer-${createRequestId()}`;

    const observed = runWithRequestContext(
      correlationId,
      () => ({ traceId: getTraceId(), traceparent: getTraceparent() }),
      { traceId: TRACE_ID, spanId: SPAN_ID, sampled: true },
    );

    expect(observed.traceId).toBe(TRACE_ID);
    expect(observed.traceparent).toBe(INCOMING);
    expect(getTraceId()).toBeUndefined();
  });
});
