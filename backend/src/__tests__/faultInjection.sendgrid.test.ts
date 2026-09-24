/**
 * Fault-injection tests — SendGrid (notificationService) (#402).
 *
 * Verifies that SendGrid API errors (403 Forbidden, 429 Too-Many-Requests) are
 * absorbed by the notification service and do not propagate to the caller.
 * Email delivery failure must never break the main application flow.
 *
 * Threat-model notes
 * ------------------
 * Email is a best-effort side-effect. A transient SendGrid outage or rate-limit
 * must not prevent loan state changes or remittance submissions from completing.
 * The service already logs the error internally; these tests confirm it does
 * not re-throw.
 *
 * Compatibility impact: read-only unit test — no schema or contract changes.
 * Rollout steps: runs automatically in CI on every PR.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ─── Mocks ────────────────────────────────────────────────────────────────────

type QueryResult = { rows: Record<string, unknown>[]; rowCount: number };
const mockQuery = jest.fn<(sql: string, params?: unknown[]) => Promise<QueryResult>>();
const mockSendGridSend = jest.fn<() => Promise<void>>();
const mockTwilioFactory = jest.fn().mockReturnValue({ messages: { create: jest.fn() } });

jest.unstable_mockModule('../db/connection.js', () => ({
  query: mockQuery,
  default: { query: mockQuery },
  getClient: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.unstable_mockModule('@sendgrid/mail', () => ({
  default: { setApiKey: jest.fn(), send: mockSendGridSend },
}));

jest.unstable_mockModule('twilio', () => ({
  default: mockTwilioFactory,
}));

// ─── Module under test ────────────────────────────────────────────────────────
const { notificationService } = await import('../services/notificationService.js');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Fault injection – SendGrid (notificationService)', () => {
  const setupQueryMocks = () => {
    // createNotification INSERT
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          user_id: 'u1',
          type: 'loan_approved',
          title: 'Approved',
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
    // notifyUserExternal: preferences SELECT — email enabled, sms disabled
    mockQuery.mockResolvedValueOnce({
      rows: [{ email_enabled: true, sms_enabled: false, phone: null, per_type_overrides: {} }],
      rowCount: 1,
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.FROM_EMAIL = 'noreply@remitlend.test';
    process.env.SENDGRID_API_KEY = 'SG.test-key';
    process.env.TWILIO_ACCOUNT_SID = 'ACtest';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    process.env.TWILIO_PHONE_NUMBER = '+15550000000';
    setupQueryMocks();
  });

  afterEach(() => {
    delete process.env.FROM_EMAIL;
    delete process.env.SENDGRID_API_KEY;
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_PHONE_NUMBER;
  });

  it('does not propagate a SendGrid 403 Forbidden error to the caller', async () => {
    mockSendGridSend.mockRejectedValue(
      Object.assign(new Error('Forbidden'), { code: 403 }),
    );

    await expect(
      notificationService.createNotification({
        userId: 'u1',
        type: 'loan_approved',
        title: 'Approved',
        message: 'Your loan is approved',
      }),
    ).resolves.toBeDefined();
  });

  it('does not propagate a SendGrid 429 rate-limit error to the caller', async () => {
    mockSendGridSend.mockRejectedValue(
      Object.assign(new Error('Too Many Requests'), { code: 429 }),
    );
    // Re-seed query mocks since clearAllMocks cleared them
    setupQueryMocks();

    await expect(
      notificationService.createNotification({
        userId: 'u1',
        type: 'loan_approved',
        title: 'Approved',
        message: 'Your loan is approved',
      }),
    ).resolves.toBeDefined();
  });
});
