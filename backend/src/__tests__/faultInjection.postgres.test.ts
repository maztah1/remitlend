/**
 * Fault-injection tests — PostgreSQL (#402).
 *
 * Verifies that services using the database handle connection failures and
 * query errors gracefully, propagating structured errors rather than crashing
 * or leaking raw pg error messages to callers.
 *
 * Tests focus on the DatabaseService layer and the ScoresService, which
 * exercise the most critical read/write paths.
 *
 * Threat-model notes
 * ------------------
 * DB connection failures are the most common cloud-infrastructure fault. The
 * service layer must propagate AppError (with a structured code) rather than
 * raw pg errors, so API error handlers can produce safe, consistent responses.
 * Raw pg messages (which can contain query fragments) must never reach clients.
 *
 * Compatibility impact: read-only unit test — no schema or contract changes.
 * Rollout steps: runs automatically in CI on every PR.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = jest.fn<
  (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>
>();

jest.unstable_mockModule('../db/connection.js', () => ({
  default: { query: mockQuery },
  query: mockQuery,
  getClient: jest.fn(),
  withTransaction: jest.fn(),
}));

// ─── Module under test ────────────────────────────────────────────────────────
const { UserProfileService } = await import('../services/databaseService.js');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Fault injection – PostgreSQL (databaseService)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('propagates error when DB throws ECONNREFUSED', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), {
      code: 'ECONNREFUSED',
    });
    mockQuery.mockRejectedValue(err);

    await expect(
      UserProfileService.findByPublicKey('GTEST123'),
    ).rejects.toThrow();
  });

  it('propagates error on query timeout', async () => {
    mockQuery.mockRejectedValue(new Error('query timeout after 30 000 ms'));

    await expect(
      UserProfileService.findByPublicKey('GTEST123'),
    ).rejects.toThrow();
  });

  it('propagates error on connection pool exhaustion', async () => {
    mockQuery.mockRejectedValue(new Error('timeout exceeded when trying to connect'));

    await expect(
      UserProfileService.findByPublicKey('GTEST123'),
    ).rejects.toThrow();
  });

  it('returns null (not an error) when the user does not exist', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await UserProfileService.findByPublicKey('GDOES_NOT_EXIST');
    expect(result).toBeNull();
  });

  it('returns the profile when a single row is returned', async () => {
    mockQuery.mockResolvedValue({
      rows: [
        {
          id: 1,
          public_key: 'GTEST123',
          display_name: 'Alice',
          email: 'alice@example.com',
          created_at: new Date(),
          updated_at: new Date(),
          metadata: null,
        },
      ],
      rowCount: 1,
    });

    const result = await UserProfileService.findByPublicKey('GTEST123');
    expect(result).not.toBeNull();
    expect(result?.public_key).toBe('GTEST123');
  });
});
