/**
 * Fault-injection tests — Outbound HTTP / fetch (WebhookService) (#402).
 *
 * Verifies that failed webhook deliveries (DNS failure, HTTP 5xx, rate-limit)
 * are persisted to the `webhook_deliveries` table for retry processing, and
 * that a failure for one subscriber does not prevent delivery to others.
 *
 * Threat-model notes
 * ------------------
 * Webhook delivery is fire-and-forget from the caller's perspective; consumers
 * can be temporarily unreachable. The service must:
 *   - Never throw to the event pipeline on delivery failure
 *   - Record the failure with HTTP status so retry backoff can be applied
 *   - Continue delivering to all other subscribers even if one is broken
 *
 * Compatibility impact: read-only unit test — no schema or contract changes.
 * Rollout steps: runs automatically in CI on every PR.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = jest.fn<(text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  closePool: jest.fn(),
}));

// ─── Module under test ────────────────────────────────────────────────────────
const { WebhookService } = await import('../services/webhookService.js');

// ─── Shared fixture ───────────────────────────────────────────────────────────

const BASE_EVENT = {
  eventId: 'evt-fault-webhook-001',
  eventType: 'LoanApproved' as const,
  loanId: 1,
  address: 'GBORROWER_FAULT',
  ledger: 100,
  ledgerClosedAt: new Date('2025-01-01T00:00:00.000Z'),
  txHash: 'tx-fault-001',
  contractId: 'C_FAULT',
  topics: [] as unknown[],
  value: 'xdr',
};

const SUBSCRIBER = { id: 99, callback_url: 'https://consumer.example/hook', secret: null };

const originalFetch = global.fetch;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Fault injection – Outbound HTTP / fetch (WebhookService)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    // Default: subscription lookup returns one subscriber
    mockQuery
      .mockResolvedValueOnce({ rows: [SUBSCRIBER] })
      .mockResolvedValueOnce({ rows: [] }); // delivery INSERT
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('does not throw when fetch rejects with a DNS error', async () => {
    global.fetch = jest
      .fn<typeof fetch>()
      .mockRejectedValue(
        new TypeError('fetch failed: ENOTFOUND consumer.example'),
      ) as typeof fetch;

    const service = new WebhookService();
    await expect(service.dispatch(BASE_EVENT)).resolves.not.toThrow();
  });

  it('records HTTP 503 status in webhook_deliveries INSERT', async () => {
    global.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: false, status: 503 } as Response) as typeof fetch;

    const service = new WebhookService();
    await service.dispatch(BASE_EVENT);

    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO webhook_deliveries'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1] as unknown[]).toContain(503);
  });

  it('records HTTP 429 (rate-limit) status in webhook_deliveries INSERT', async () => {
    global.fetch = jest
      .fn<typeof fetch>()
      .mockResolvedValue({ ok: false, status: 429 } as Response) as typeof fetch;

    const service = new WebhookService();
    await service.dispatch(BASE_EVENT);

    const insertCall = mockQuery.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO webhook_deliveries'),
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1] as unknown[]).toContain(429);
  });

  it('continues delivering to subsequent subscribers when one is unreachable', async () => {
    const fetchMock = jest
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);
    global.fetch = fetchMock as typeof fetch;

    // Return two subscribers for this test
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({
        rows: [
          { id: 1, callback_url: 'https://bad.example/hook', secret: null },
          { id: 2, callback_url: 'https://good.example/hook', secret: null },
        ],
      })
      .mockResolvedValue({ rows: [] });

    const service = new WebhookService();
    await service.dispatch(BASE_EVENT);

    // fetch must be called for both subscribers
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
