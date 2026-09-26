/**
 * Unit coverage for the W3C Trace Context helpers (#414).
 *
 * These helpers are the trust boundary for caller-supplied `traceparent`
 * values, so the tests cover the success path, every rejection class
 * (malformed, oversized, all-zero, unsupported version), sampling decisions
 * and their bounds, and the child/outbound derivation used by the indexer,
 * webhooks, and chain confirmation.
 */

import { jest } from '@jest/globals';
import {
  MAX_TRACEPARENT_LENGTH,
  MAX_TRACESTATE_LENGTH,
  TRACE_CONTEXT_VERSION,
  childTraceContext,
  createSpanId,
  createTraceContext,
  createTraceId,
  decideRootSampling,
  formatTraceparent,
  outboundTraceparent,
  outboundTraceContext,
  parseTraceparent,
  sanitizeTracestate,
} from '../utils/traceContext.js';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN_ID = '00f067aa0ba902b7';

const validHeader = (flags = '01') => `${TRACE_CONTEXT_VERSION}-${TRACE_ID}-${SPAN_ID}-${flags}`;

describe('trace context helpers', () => {
  const originalSampleRate = process.env.TRACE_CONTEXT_SAMPLE_RATE;

  afterEach(() => {
    if (originalSampleRate === undefined) {
      delete process.env.TRACE_CONTEXT_SAMPLE_RATE;
    } else {
      process.env.TRACE_CONTEXT_SAMPLE_RATE = originalSampleRate;
    }
    jest.restoreAllMocks();
  });

  describe('id generation', () => {
    it('generates correctly sized hex ids that are never all-zero', () => {
      for (let i = 0; i < 50; i += 1) {
        expect(createTraceId()).toMatch(/^[0-9a-f]{32}$/);
        expect(createSpanId()).toMatch(/^[0-9a-f]{16}$/);
      }
    });

    it('generates unique trace ids across a burst', () => {
      const ids = new Set(Array.from({ length: 500 }, () => createTraceId()));
      expect(ids.size).toBe(500);
    });
  });

  describe('parseTraceparent - success path', () => {
    it('parses a valid sampled header', () => {
      expect(parseTraceparent(validHeader('01'))).toEqual({
        version: '00',
        traceId: TRACE_ID,
        parentSpanId: SPAN_ID,
        spanId: SPAN_ID,
        sampled: true,
      });
    });

    it('parses a valid unsampled header', () => {
      expect(parseTraceparent(validHeader('00'))?.sampled).toBe(false);
    });

    it('tolerates surrounding whitespace', () => {
      const parsed = parseTraceparent(`  ${validHeader()}  `);
      expect(parsed?.traceId).toBe(TRACE_ID);
      expect(parsed?.sampled).toBe(true);
    });
  });

  describe('parseTraceparent - failure and boundary paths', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['empty', ''],
      ['whitespace only', '   '],
      ['single part', '00'],
      ['three parts', `00-${TRACE_ID}-${SPAN_ID}`],
      ['five parts', `00-${TRACE_ID}-${SPAN_ID}-01-extra`],
      ['short trace id', `00-${TRACE_ID.slice(0, 30)}-${SPAN_ID}-01`],
      ['non-hex trace id', `00-${'z'.repeat(32)}-${SPAN_ID}-01`],
      ['all-zero trace id', `00-${'0'.repeat(32)}-${SPAN_ID}-01`],
      ['all-zero span id', `00-${TRACE_ID}-${'0'.repeat(16)}-01`],
      ['non-hex flags', `00-${TRACE_ID}-${SPAN_ID}-zz`],
      ['unsupported version ff', `ff-${TRACE_ID}-${SPAN_ID}-01`],
    ])('rejects %s', (_label, raw) => {
      expect(parseTraceparent(raw as string | null | undefined)).toBeNull();
    });

    it('rejects a header longer than the accepted maximum (bounded parsing)', () => {
      const oversized = validHeader() + 'a'.repeat(MAX_TRACEPARENT_LENGTH);
      expect(oversized.length).toBeGreaterThan(MAX_TRACEPARENT_LENGTH);
      expect(parseTraceparent(oversized)).toBeNull();
    });
  });

  describe('sampling decisions', () => {
    it('defaults to sampled when the rate is unset', () => {
      delete process.env.TRACE_CONTEXT_SAMPLE_RATE;
      expect(decideRootSampling(() => 0.999)).toBe(true);
    });

    it('honours a configured sampling rate', () => {
      process.env.TRACE_CONTEXT_SAMPLE_RATE = '0';
      expect(decideRootSampling(() => 0)).toBe(false);

      process.env.TRACE_CONTEXT_SAMPLE_RATE = '1';
      expect(decideRootSampling(() => 0.999)).toBe(true);
    });

    it.each(['-1', '2', 'not-a-number'])(
      'falls back to sampling everything for the out-of-range rate %s',
      (rate) => {
        process.env.TRACE_CONTEXT_SAMPLE_RATE = rate;
        expect(decideRootSampling(() => 0.999)).toBe(true);
      },
    );

    it('encodes the sampled decision into the formatted header', () => {
      expect(formatTraceparent({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: true })).toBe(
        validHeader('01'),
      );
      expect(formatTraceparent({ traceId: TRACE_ID, spanId: SPAN_ID, sampled: false })).toBe(
        validHeader('00'),
      );
    });
  });

  describe('child and outbound derivation', () => {
    it('preserves the trace id and sampling decision while minting a new span', () => {
      const parent = { traceId: TRACE_ID, spanId: SPAN_ID, sampled: false };
      const child = childTraceContext(parent);

      expect(child.traceId).toBe(parent.traceId);
      expect(child.sampled).toBe(false);
      expect(child.spanId).not.toBe(parent.spanId);
      expect(child.spanId).toMatch(/^[0-9a-f]{16}$/);
    });

    it('continues an existing trace for outbound hops', () => {
      const current = createTraceContext({ sampled: true });
      const outbound = outboundTraceContext(current);

      expect(outbound.traceId).toBe(current.traceId);
      expect(outbound.spanId).not.toBe(current.spanId);
      expect(parseTraceparent(outboundTraceparent(current))).not.toBeNull();
    });

    it('starts a fresh root trace when there is no active context', () => {
      const outbound = outboundTraceContext(undefined);
      expect(outbound.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(parseTraceparent(outboundTraceparent(undefined))).not.toBeNull();
    });
  });

  describe('tracestate pass-through', () => {
    it('accepts a bounded, printable tracestate', () => {
      expect(sanitizeTracestate('congo=t61rcWkgMzE,rojo=00f067aa0ba902b7')).toBe(
        'congo=t61rcWkgMzE,rojo=00f067aa0ba902b7',
      );
    });

    it.each([
      ['undefined', undefined],
      ['empty', ''],
      ['control characters', 'congo=t61\rcWkgMzE'],
      ['oversized', 'a'.repeat(MAX_TRACESTATE_LENGTH + 1)],
    ])('drops %s', (_label, raw) => {
      expect(sanitizeTracestate(raw as string | undefined)).toBeUndefined();
    });
  });
});
