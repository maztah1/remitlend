/**
 * Fault-injection tests — Twilio (notificationService) (#402).
 *
 * Verifies that Twilio errors (401 auth failure, ECONNRESET) are absorbed by
 * the notification service without propagating to callers. SMS delivery is a
 * best-effort side-effect; failures must never block the main application flow.
 *
 * Threat-model notes
 * ------------------
 * Twilio credentials can expire or be rotated without a deployment; an
 * authentication error must log cleanly and not crash the event pipeline.
 * Similarly, transient connectivity resets (ECONNRESET) should degrade SMS
 * delivery silently rather than surfacing as a 500 to the API consumer.
 *
 * Compatibility impact: read-only unit test — no schema or contract changes.
 * Rollout steps: runs automatically in CI on every PR.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ─── Mocks ────────────────────────────────────────────────────────────────────

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();
const mockTwilioCreate = jest.fn<() => Promise<{ sid: string }>>();
const mockTwilioFactory = jest
  .fn()
  .mockReturnValue({ messages: { create: mockTwilioCreate } });

jest.unstable_mockModule('../db/connection.js', () => ({
  query: mockQuery,
  default: { query: mockQuery },
  getClient: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.unstable_mockModule('@sendgrid/mail', () => ({
  default: {
    setApiKey: jest.fn(),
    send: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  },
}));

jest.unstable_mockModule('twilio', () => ({
  default: mockTwilioFactory,
}));

// ─── Module under test ────────────────────────────────────────────────────────
const { notificationService } = await import('../services/notificationService.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function seedQueryMocks() {
  // createNotification INSERT
  mockQuery.mockResolvedValueOnce({
    rows: [
      {
        id: 2,
        user_id: 'u2',
        type: 'repayment_due',
        title: 'Repay',
        message: 'msg',
        loan_id: null,
        action_url: null,
        read: false,
        status: 'unread',
        created_at: new Date(),
      },
    ],
    rowCount: 1,
  });
  // notifyUserExternal: preferences SELECT — sms enabled, email disabled
  mockQuery.mockResolvedValueOnce({
    rows: [
      {
        email_enabled: false,
        sms_enabled: true,
        phone: '+15559876543',
        per_type_overrides: {},
      },
    ],
    rowCount: 1,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Fault injection – Twilio (notificationService)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FROM_EMAIL = 'noreply@remitlend.test';
    process.env.SENDGRID_API_KEY = 'SG.test';
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    process.env.TWILIO_PHONE_NUMBER = '+15550000000';
    seedQueryMocks();
  });

  afterEach(() => {
    delete process.env.FROM_EMAIL;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
  });

  it('does not propagate a Twilio 401 Authentication Error to the caller', async () => {
    mockTwilioCreate.mockRejectedValue(
      Object.assign(new Error('Authentication Error'), { status: 401 }),
    );

    await expect(
      notificationService.createNotification({
        userId: 'u2',
        type: 'repayment_due',
        title: 'Repay',
        message: 'Repayment due',
      }),
    ).resolves.toBeDefined();
  });

  it('does not propagate a Twilio ECONNRESET error to the caller', async () => {
    mockTwilioCreate.mockRejectedValue(new Error('ECONNRESET'));
    seedQueryMocks(); // re-seed since previous test consumed them

    await expect(
      notificationService.createNotification({
        userId: 'u2',
        type: 'repayment_due',
        title: 'Repay',
        message: 'Repayment due',
      }),
    ).resolves.toBeDefined();
  });
});
