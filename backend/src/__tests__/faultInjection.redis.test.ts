/**
 * Fault-injection tests — Redis / cacheService (#402).
 *
 * Verifies that Redis connection failures and command errors are handled
 * gracefully by the cacheService without crashing or propagating raw errors
 * to callers. Cache operations are fail-safe by design.
 *
 * Threat-model notes
 * ------------------
 * Redis is used for rate-limiting and response caching. A Redis outage must
 * degrade the cache silently (returning null / not caching) rather than
 * bringing down the API. The cacheService must absorb Redis errors.
 *
 * Compatibility impact: read-only unit test — no schema or contract changes.
 * Rollout steps: runs automatically in CI on every PR.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockConnect = jest.fn<() => Promise<void>>();
const mockOn = jest.fn();
const mockGet = jest.fn<() => Promise<string | null>>();
const mockSet = jest.fn<() => Promise<string>>();
const mockDel = jest.fn<() => Promise<number>>();
const mockPing = jest.fn<() => Promise<string>>();
const mockEval = jest.fn<() => Promise<unknown>>();

jest.unstable_mockModule('redis', () => ({
  createClient: () => ({
    connect: mockConnect,
    on: mockOn,
    get: mockGet,
    set: mockSet,
    del: mockDel,
    ping: mockPing,
    eval: mockEval,
  }),
}));

// ─── Module under test ────────────────────────────────────────────────────────
const { cacheService } = await import('../services/cacheService.js');

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Fault injection – Redis (cacheService)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: connect succeeds
    mockConnect.mockResolvedValue(undefined);
  });

  it('returns null (not an error) when GET throws ECONNREFUSED', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), {
      code: 'ECONNREFUSED',
    });
    mockGet.mockRejectedValue(err);

    const result = await cacheService.get('some-key');
    // cacheService.get must swallow errors and return null on failure
    expect(result).toBeNull();
  });

  it('returns null when GET throws a generic Redis command error', async () => {
    mockGet.mockRejectedValue(new Error('ERR command not allowed on replica'));

    const result = await cacheService.get('some-key');
    expect(result).toBeNull();
  });

  it('does not throw when SET fails with ECONNRESET', async () => {
    mockSet.mockRejectedValue(new Error('ECONNRESET'));

    await expect(cacheService.set('k', 'v', 60)).resolves.not.toThrow();
  });

  it('does not throw when DELETE fails with a connection error', async () => {
    mockDel.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(cacheService.delete('k')).resolves.not.toThrow();
  });

  it('returns false from deleteIfMatch when Redis eval throws', async () => {
    mockEval.mockRejectedValue(new Error('Redis connection failed'));

    const result = await cacheService.deleteIfMatch('lock:test', 'my-value');
    expect(result).toBe(false);
  });
});
