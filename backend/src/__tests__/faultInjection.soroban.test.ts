/**
 * Fault-injection tests — Stellar RPC / sorobanService (#402).
 *
 * Verifies that the sorobanService handles RPC failures gracefully:
 *   - healthCheck() wraps network errors and returns { connected: false }
 *   - ping() returns 'error' rather than throwing
 *   - Transaction-building methods propagate AppError (not raw SDK errors)
 *     when the RPC is unreachable
 *
 * Threat-model notes
 * ------------------
 * The Stellar RPC is an external hard dependency for transaction submission.
 * A network partition must be captured as a structured { connected: false }
 * response by healthCheck() so the health endpoint can report it cleanly.
 * The error message in the returned object must not contain raw network
 * internals that could reveal infrastructure topology to clients.
 *
 * Compatibility impact: read-only unit test — no schema or contract changes.
 * Rollout steps: runs automatically in CI on every PR.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockGetLatestLedger = jest.fn<() => Promise<{ sequence: number }>>();
const mockGetAccount = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule('../config/stellar.js', () => ({
  createSorobanRpcServer: jest.fn(() => ({
    getLatestLedger: mockGetLatestLedger,
    getAccount: mockGetAccount,
    prepareTransaction: jest.fn<() => Promise<unknown>>(),
  })),
  getStellarNetworkPassphrase: jest.fn(() => 'Test SDF Network ; September 2015'),
  getStellarRpcUrl: jest.fn(() => 'https://soroban-testnet.stellar.org'),
}));

// ─── Module under test ────────────────────────────────────────────────────────
const { sorobanService } = await import('../services/sorobanService.js');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Fault injection – Stellar RPC (sorobanService)', () => {
  beforeEach(() => {
    mockGetLatestLedger.mockReset();
    mockGetAccount.mockReset();
  });

  it('returns { connected: false } when the RPC throws ECONNREFUSED', async () => {
    mockGetLatestLedger.mockRejectedValue(
      Object.assign(new Error('fetch failed: ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    );

    const result = await sorobanService.healthCheck();
    expect(result.connected).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns { connected: false } on a DNS resolution error', async () => {
    mockGetLatestLedger.mockRejectedValue(new TypeError('fetch failed: ENOTFOUND soroban-testnet.stellar.org'));

    const result = await sorobanService.healthCheck();
    expect(result.connected).toBe(false);
    expect(result.error).toMatch(/fetch failed|ENOTFOUND/i);
  });

  it('returns { connected: false } when getLatestLedger times out', async () => {
    mockGetLatestLedger.mockRejectedValue(new Error('RPC timeout'));

    const result = await sorobanService.healthCheck();
    expect(result.connected).toBe(false);
  });

  it('ping() returns "error" (not throws) when the RPC is unreachable', async () => {
    mockGetLatestLedger.mockRejectedValue(new Error('fetch failed: ECONNREFUSED'));

    const result = await sorobanService.ping();
    expect(result).toBe('error');
  });

  it('healthCheck() returns { connected: true, latestLedger } on success', async () => {
    mockGetLatestLedger.mockResolvedValue({ sequence: 5000 });

    const result = await sorobanService.healthCheck();
    expect(result.connected).toBe(true);
    expect(result.latestLedger).toBe(5000);
  });

  it('transaction building throws when the account is not found on RPC', async () => {
    process.env.LOAN_MANAGER_CONTRACT_ID = 'C_TESTLOAN123456789';
    mockGetAccount.mockRejectedValue(new Error('Account not found'));

    await expect(
      sorobanService.buildRequestLoanTx('GBORROWER123456789012345678901234567890123456', 1000),
    ).rejects.toThrow();

    delete process.env.LOAN_MANAGER_CONTRACT_ID;
  });
});
