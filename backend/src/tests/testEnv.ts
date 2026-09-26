/**
 * Cross-layer deterministic test environment — issue #369.
 *
 * Purpose
 * ───────
 * Financial tests must be fully deterministic: same inputs → same outputs on
 * every run, every machine, with no hidden coupling to wall-clock time,
 * `Math.random()`, network state, or environment variables.
 *
 * This module exports helpers that freeze or control every non-deterministic
 * source used by the backend's financial layer so tests can rely on exact
 * numeric equality rather than `toBeCloseTo` tolerances.
 *
 * Usage
 * ─────
 * ```ts
 * import { withDeterministicEnv, seedLcg } from '../testEnv.js';
 *
 * describe('my financial test', () => {
 *   withDeterministicEnv();          // ← sets up / tears down per test
 *
 *   it('computes interest exactly', () => {
 *     // Date.now() returns TEST_EPOCH_MS; Math.random() returns the LCG
 *     ...
 *   });
 * });
 * ```
 *
 * @module testEnv
 */

import { beforeEach, afterEach } from '@jest/globals';

// ─── Deterministic epoch ─────────────────────────────────────────────────────

/**
 * Fixed timestamp used for `Date.now()` and `new Date()` inside deterministic
 * test blocks.
 *
 * Value: 2024-01-15T00:00:00.000Z in Unix milliseconds.
 * Chosen because:
 *  - It is a mid-month Monday — avoids DST or month-boundary edge cases.
 *  - It pre-dates the first production loan, so any future snapshot
 *    comparisons against real data will not collide.
 */
export const TEST_EPOCH_MS = 1705276800000; // 2024-01-15T00:00:00.000Z

/**
 * A `Date` instance at the test epoch, useful as the `startDate` argument in
 * `buildAmortizationSchedule` and similar functions that accept a `Date`.
 */
export const TEST_EPOCH_DATE = new Date(TEST_EPOCH_MS);

// ─── Deterministic PRNG (LCG) ────────────────────────────────────────────────

/**
 * Minimal Linear Congruential Generator.
 *
 * Parameters taken from the POSIX `rand()` specification (same constants
 * used across multiple tests in this repo to avoid introducing a new
 * dependency).  The sequence is fully determined by `seed`.
 *
 * Returns values in [0, 1) just like `Math.random()`.
 */
export function makeLcg(seed = 0x1378_1378): () => number {
  let s = seed >>> 0;
  return () => {
    s = ((s * 1103515245 + 12345) >>> 0);
    return s / 0x100000000;
  };
}

// ─── Loan-config env defaults ────────────────────────────────────────────────

/**
 * Minimal, valid loan-config env vars required by `getLoanConfig()`.
 *
 * Tests that exercise code paths calling `getLoanConfig()` should apply this
 * object via `Object.assign(process.env, LOAN_CONFIG_ENV)` inside
 * `beforeEach`, then restore / delete the keys in `afterEach`.
 */
export const LOAN_CONFIG_ENV: Record<string, string> = {
  LOAN_MIN_SCORE: '500',
  LOAN_MAX_AMOUNT: '10000',
  LOAN_INTEREST_RATE_PERCENT: '12',
  CREDIT_SCORE_THRESHOLD: '600',
};

// ─── Combined setup hook ─────────────────────────────────────────────────────

/**
 * Register `beforeEach` / `afterEach` hooks in the calling `describe` block
 * that:
 *  1. Freeze `Date.now()` to {@link TEST_EPOCH_MS}.
 *  2. Replace `Math.random` with a seeded LCG so any code that calls it
 *     (e.g. sampling-rate guards in the logger) produces a deterministic
 *     sequence.
 *  3. Set the minimal {@link LOAN_CONFIG_ENV} variables so financial
 *     helpers that call `getLoanConfig()` do not throw.
 *  4. Restore all originals in `afterEach`.
 *
 * @param epochMs - Override the frozen timestamp (defaults to `TEST_EPOCH_MS`).
 * @param lcgSeed - Override the LCG seed (defaults to `0x13781378`).
 */
export function withDeterministicEnv(
  epochMs: number = TEST_EPOCH_MS,
  lcgSeed = 0x1378_1378,
): void {
  let originalNow: () => number;
  let originalRandom: () => number;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Freeze Date.now()
    originalNow = Date.now;
    Date.now = () => epochMs;

    // Seeded Math.random replacement
    originalRandom = Math.random;
    const lcg = makeLcg(lcgSeed);
    Math.random = lcg;

    // Inject loan-config env vars
    for (const [key, value] of Object.entries(LOAN_CONFIG_ENV)) {
      originalEnv[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(() => {
    Date.now = originalNow;
    Math.random = originalRandom;

    // Restore env
    for (const [key, orig] of Object.entries(originalEnv)) {
      if (orig === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = orig;
      }
    }
  });
}
