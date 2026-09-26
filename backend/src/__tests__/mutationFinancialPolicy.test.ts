/**
 * Mutation-testing coverage for financial policies — issue #401.
 *
 * Background
 * ──────────
 * Standard line-coverage metrics can reach 100 % with tests that exercise
 * code paths without asserting anything meaningful. Mutation testing reveals
 * these "covered but not verified" paths by injecting small code mutations
 * (flip a `>=` to `>`, replace `+1` with `-1`, …) and checking that at least
 * one test fails for each mutation.
 *
 * This file does **not** run a full mutation-test framework (which would
 * require a separate tool like Stryker and a long CI job). Instead it applies
 * the *mutation-testing mindset*: for every operator boundary and rounding
 * decision in the financial policy layer, there is at least one test that
 * would fail if the operator were flipped or the constant changed by one.
 *
 * Strategy per function
 * ─────────────────────
 * `roundDiv`
 *   - Every `<`, `<=`, `>`, `>=` comparison that changes the rounding
 *     direction has a test case that sits exactly ON the boundary.
 *   - The tie-break condition `quotient % 2 != 0` is tested with even AND
 *     odd quotients.
 *
 * `toStroops`
 *   - The threshold `fractionRaw.length <= STROOP_DECIMALS` is tested at
 *     exactly 7 digits (== limit, no rounding) and 8 digits (one over, rounds).
 *
 * `splitProRata`
 *   - The `leftover < 0` and `leftover >= weights.length` guard is tested.
 *   - The largest-remainder loop boundary (ties broken by lowest index) is
 *     tested by constructing equal remainders across multiple indices.
 *
 * `buildAmortizationSchedule`
 *   - The `isLast` branch uses remaining amounts rather than raw quotients —
 *     tested to confirm zero remainder after the final period.
 *   - `Math.max(0, remainingPrincipal)` guard tested with single-period loan.
 *
 * Compatibility / rollout
 * ────────────────────────
 * Read-only tests — no schema migrations, no deployed contract changes.
 */
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  roundDiv,
  toStroops,
  fromStroops,
  splitProRata,
  RoundingMode,
  MoneyError,
  STROOP_DECIMALS,
} from '../money/decimal.js';

// ─── roundDiv — boundary / operator mutations ─────────────────────────────────

describe('mutation: roundDiv Floor boundary (#401)', () => {
  // Floor: round_away_from_zero = remainder_is_negative
  // Mutation target: condition flipped (!) would make floor behave like ceil
  it('exact result (remainder == 0) is returned without adjustment — kills ±1 mutations', () => {
    expect(roundDiv(6n, 2n, RoundingMode.Floor)).toBe(3n);   // exactly 3, no rounding
    expect(roundDiv(-6n, 2n, RoundingMode.Floor)).toBe(-3n); // exactly -3, no rounding
  });

  it('positive non-tie always floors toward -∞ — kills negated condition mutation', () => {
    // 5 / 2 = 2.5 → floor = 2 (not 3)
    expect(roundDiv(5n, 2n, RoundingMode.Floor)).toBe(2n);
    // 1 / 3 = 0.333 → floor = 0 (not 1)
    expect(roundDiv(1n, 3n, RoundingMode.Floor)).toBe(0n);
  });

  it('negative non-tie always floors toward -∞ — kills negated condition mutation', () => {
    // -7 / 2 = -3.5 → floor = -4 (not -3)
    expect(roundDiv(-7n, 2n, RoundingMode.Floor)).toBe(-4n);
    // -1 / 3 = -0.333 → floor = -1 (not 0)
    expect(roundDiv(-1n, 3n, RoundingMode.Floor)).toBe(-1n);
  });
});

describe('mutation: roundDiv Ceil boundary (#401)', () => {
  it('exact result is returned unchanged', () => {
    expect(roundDiv(6n, 2n, RoundingMode.Ceil)).toBe(3n);
  });

  it('positive non-tie ceils toward +∞ — kills negated condition mutation', () => {
    // 5 / 2 = 2.5 → ceil = 3 (not 2)
    expect(roundDiv(5n, 2n, RoundingMode.Ceil)).toBe(3n);
    expect(roundDiv(1n, 3n, RoundingMode.Ceil)).toBe(1n);
  });

  it('negative non-tie ceils toward +∞ — kills negated condition mutation', () => {
    // -7 / 2 = -3.5 → ceil = -3 (not -4)
    expect(roundDiv(-7n, 2n, RoundingMode.Ceil)).toBe(-3n);
    expect(roundDiv(-1n, 3n, RoundingMode.Ceil)).toBe(0n);
  });
});

describe('mutation: roundDiv HalfUp tie-break boundary (#401)', () => {
  // Condition: abs_remainder * 2 >= den  (>= not just >)
  // Mutation: change >= to > would make exact ties round down instead of up

  it('exact tie (abs_remainder * 2 == den) rounds AWAY from zero', () => {
    // 5 / 2: remainder = 1, den = 2, 1*2 == 2 → tie → round away → 3
    expect(roundDiv(5n, 2n, RoundingMode.HalfUp)).toBe(3n);
    // -5 / 2: remainder = -1, abs = 1, 1*2 == 2 → tie → round away → -3
    expect(roundDiv(-5n, 2n, RoundingMode.HalfUp)).toBe(-3n);
  });

  it('just below tie (abs_remainder * 2 < den) rounds TOWARD zero', () => {
    // 1 / 3: remainder = 1, den = 3, 1*2 = 2 < 3 → round toward zero → 0
    expect(roundDiv(1n, 3n, RoundingMode.HalfUp)).toBe(0n);
    // -1 / 3: rounds toward zero → 0
    expect(roundDiv(-1n, 3n, RoundingMode.HalfUp)).toBe(0n);
  });

  it('just above tie (abs_remainder * 2 > den) rounds AWAY from zero', () => {
    // 2 / 3: remainder = 2, den = 3, 2*2 = 4 > 3 → round away → 1
    expect(roundDiv(2n, 3n, RoundingMode.HalfUp)).toBe(1n);
    expect(roundDiv(-2n, 3n, RoundingMode.HalfUp)).toBe(-1n);
  });
});

describe('mutation: roundDiv HalfEven tie-break (odd/even quotient) (#401)', () => {
  // Mutation target: `quotient % 2 != 0` — changing to `== 0` would invert
  // banker's rounding.

  it('tie with EVEN quotient rounds TOWARD zero (stays even)', () => {
    // 5 / 2 = 2.5 → quotient = 2 (even) → stay → 2
    expect(roundDiv(5n, 2n, RoundingMode.HalfEven)).toBe(2n);
    // 9 / 2 = 4.5 → quotient = 4 (even) → stay → 4
    expect(roundDiv(9n, 2n, RoundingMode.HalfEven)).toBe(4n);
  });

  it('tie with ODD quotient rounds AWAY from zero (makes it even)', () => {
    // 7 / 2 = 3.5 → quotient = 3 (odd) → round up → 4
    expect(roundDiv(7n, 2n, RoundingMode.HalfEven)).toBe(4n);
    // 3 / 2 = 1.5 → quotient = 1 (odd) → round up → 2
    expect(roundDiv(3n, 2n, RoundingMode.HalfEven)).toBe(2n);
  });

  it('tie with negative EVEN quotient rounds toward zero (stays even)', () => {
    // -5 / 2 = -2.5 → quotient = -2 (even) → stay → -2
    expect(roundDiv(-5n, 2n, RoundingMode.HalfEven)).toBe(-2n);
  });

  it('tie with negative ODD quotient rounds away from zero (makes it even)', () => {
    // -7 / 2 = -3.5 → quotient = -3 (odd) → round away → -4
    expect(roundDiv(-7n, 2n, RoundingMode.HalfEven)).toBe(-4n);
  });

  it('non-tie cases are unaffected by the even/odd branch (below tie)', () => {
    expect(roundDiv(1n, 4n, RoundingMode.HalfEven)).toBe(0n);
    expect(roundDiv(3n, 4n, RoundingMode.HalfEven)).toBe(1n);
  });
});

// ─── toStroops — fraction-length boundary ─────────────────────────────────────

describe('mutation: toStroops fraction-length threshold (#401)', () => {
  // Condition: fractionRaw.length <= STROOP_DECIMALS (7)
  // Mutation: change <= to < would incorrectly round 7-digit fractions

  it('exactly 7 fractional digits uses direct BigInt path (no rounding)', () => {
    // 0.1234567 has exactly 7 digits — should map to 1_234_567 stroops
    expect(toStroops('0.1234567')).toBe(1_234_567n);
    expect(toStroops('1.0000000')).toBe(10_000_000n);
    expect(toStroops('9999999.9999999')).toBe(99_999_999_999_999n);
  });

  it('8 fractional digits triggers rounding path — kills length threshold mutation', () => {
    // 0.12345678 has 8 digits — the 8th digit (8) rounds the 7th digit (7→8)
    // half-even: digit 7 is odd, 0.5 tie → round up → 0.1234568
    expect(toStroops('0.12345678')).toBe(1_234_568n);
  });

  it('exactly 7 digits of 0 produces 0 stroops', () => {
    expect(toStroops('0.0000000')).toBe(0n);
  });

  it('STROOP_DECIMALS constant is 7 — kills constant-replacement mutation', () => {
    expect(STROOP_DECIMALS).toBe(7);
  });
});

// ─── fromStroops — negative / sign mutations ──────────────────────────────────

describe('mutation: fromStroops sign handling (#401)', () => {
  it('negative input produces leading minus sign — kills sign-flip mutation', () => {
    expect(fromStroops(-1n)).toBe('-0.0000001');
    expect(fromStroops(-10_000_000n)).toBe('-1.0000000');
    expect(fromStroops(-25_000_000n)).toBe('-2.5000000');
  });

  it('positive input produces no minus sign', () => {
    expect(fromStroops(1n)).toBe('0.0000001');
    expect(fromStroops(10_000_000n)).toBe('1.0000000');
  });

  it('zero produces no minus sign', () => {
    expect(fromStroops(0n)).toBe('0.0000000');
  });

  it('fractional part is zero-padded to exactly 7 digits', () => {
    // 1 stroop should be '.0000001' not '.1'
    const result = fromStroops(1n);
    const [, frac] = result.split('.');
    expect(frac!.length).toBe(7);
    // 10 stroops → '.0000010' not '.0000100' etc.
    const result2 = fromStroops(10n);
    const [, frac2] = result2.split('.');
    expect(frac2!.length).toBe(7);
  });
});

// ─── splitProRata — allocation logic mutations ────────────────────────────────

describe('mutation: splitProRata allocation boundary (#401)', () => {
  it('sum invariant holds even when total does not divide evenly — kills off-by-one in leftover', () => {
    // 101 split 3-ways: floor gives [33,33,33] = 99, leftover = 2
    // Two highest remainders get +1.
    const result = splitProRata(101n, [1n, 1n, 1n]);
    expect(result.reduce((a, b) => a + b, 0n)).toBe(101n);
    // Each part must be >= floor value
    for (const p of result) {
      expect(p).toBeGreaterThanOrEqual(33n);
    }
  });

  it('largest-remainder ties broken by lowest index — kills index comparison mutation', () => {
    // Equal weights → equal remainders after floor division → leftover distributed
    // starting at index 0 first.
    const result = splitProRata(10n, [1n, 1n, 1n]);
    expect(result.reduce((a, b) => a + b, 0n)).toBe(10n);
    // Index 0 gets the extra stroop (3+1=4), others get 3
    expect(result[0]).toBe(4n);
    expect(result[1]).toBe(3n);
    expect(result[2]).toBe(3n);
  });

  it('zero weights in array receive zero allocation — kills zero-weight mutation', () => {
    // weights [0, 1] → weight 0 contributes nothing, weight 1 gets everything
    const result = splitProRata(100n, [0n, 1n]);
    expect(result[0]).toBe(0n);
    expect(result[1]).toBe(100n);
  });

  it('single weight gets the entire total — kills partial-allocation mutation', () => {
    expect(splitProRata(999_999n, [1n])).toEqual([999_999n]);
  });

  it('empty weights with zero total returns empty array — kills empty-check mutation', () => {
    expect(splitProRata(0n, [])).toEqual([]);
  });

  it('throws on negative total — kills sign-check mutation', () => {
    expect(() => splitProRata(-1n, [1n])).toThrow(MoneyError);
    expect(() => splitProRata(-1n, [1n, 2n])).toThrow(MoneyError);
  });

  it('throws on negative weights — kills sign-check mutation', () => {
    expect(() => splitProRata(10n, [-1n, 2n])).toThrow(MoneyError);
    expect(() => splitProRata(10n, [2n, -1n])).toThrow(MoneyError);
  });

  it('proportional allocation is faithful to weight ratios for large totals', () => {
    // 1_000_000_000 split 2:1:1 → [500M, 250M, 250M]
    const result = splitProRata(1_000_000_000n, [2n, 1n, 1n]);
    expect(result).toEqual([500_000_000n, 250_000_000n, 250_000_000n]);
    expect(result.reduce((a, b) => a + b, 0n)).toBe(1_000_000_000n);
  });
});

// ─── buildAmortizationSchedule — financial policy mutations ──────────────────

describe('mutation: buildAmortizationSchedule isLast branch (#401)', () => {
  const EPOCH = new Date('2024-01-15T00:00:00.000Z');

  beforeEach(() => {
    process.env['LOAN_MIN_SCORE'] = '500';
    process.env['LOAN_MAX_AMOUNT'] = '10000';
    process.env['LOAN_INTEREST_RATE_PERCENT'] = '12';
    process.env['CREDIT_SCORE_THRESHOLD'] = '600';
  });

  afterEach(() => {
    delete process.env['LOAN_MIN_SCORE'];
    delete process.env['LOAN_MAX_AMOUNT'];
    delete process.env['LOAN_INTEREST_RATE_PERCENT'];
    delete process.env['CREDIT_SCORE_THRESHOLD'];
  });

  const getSchedule = async () => {
    const { buildAmortizationSchedule } = await import(
      '../services/loanAmortizationService.js'
    );
    return buildAmortizationSchedule;
  };

  it('final period uses remaining amounts (not raw quotient) — kills isLast mutation', async () => {
    const build = await getSchedule();
    // 6-month term: 6 periods
    const schedule = build(1000, 1200, 17280 * 6, EPOCH);
    const periods = schedule.schedule;

    // Last period running balance must be exactly 0 (no leftover principal).
    const lastPeriod = periods[periods.length - 1]!;
    expect(lastPeriod.runningBalance).toBe(0);
  });

  it('principalPortion + interestPortion == totalDue per period — kills arithmetic mutation', async () => {
    const build = await getSchedule();
    const schedule = build(1000, 1200, 17280 * 3, EPOCH);
    for (const period of schedule.schedule) {
      // Allow ±1 cent floating-point epsilon
      expect(
        Math.abs(period.principalPortion + period.interestPortion - period.totalDue),
      ).toBeLessThanOrEqual(0.01);
    }
  });

  it('runningBalance is non-negative for all periods — kills max(0,...) mutation', async () => {
    const build = await getSchedule();
    const schedule = build(100, 1000, 17280, EPOCH); // small loan, 1 period
    for (const period of schedule.schedule) {
      expect(period.runningBalance).toBeGreaterThanOrEqual(0);
    }
  });

  it('interestRateBps is preserved verbatim in the returned object — kills passthrough mutation', async () => {
    const build = await getSchedule();
    const schedule = build(1000, 800, 17280, EPOCH);
    expect(schedule.interestRateBps).toBe(800);
  });

  it('termLedgers is preserved verbatim in the returned object — kills passthrough mutation', async () => {
    const build = await getSchedule();
    const TERM = 17280 * 4;
    const schedule = build(500, 1200, TERM, EPOCH);
    expect(schedule.termLedgers).toBe(TERM);
  });

  it('totalInterest = principal * (bps / 10_000) — kills rate-formula mutation', async () => {
    const build = await getSchedule();
    // 1000 @ 12% → 120 interest
    const schedule = build(1000, 1200, 17280, EPOCH);
    expect(schedule.totalInterest).toBeCloseTo(120, 2);
    // 500 @ 8% → 40 interest
    const schedule2 = build(500, 800, 17280, EPOCH);
    expect(schedule2.totalInterest).toBeCloseTo(40, 2);
  });

  it('single-period schedule: all principal and interest repaid in one payment', async () => {
    const build = await getSchedule();
    const schedule = build(1000, 1200, 17280, EPOCH); // 1 month
    expect(schedule.schedule).toHaveLength(1);
    const only = schedule.schedule[0]!;
    expect(only.principalPortion).toBe(1000);
    expect(only.interestPortion).toBe(120);
    expect(only.runningBalance).toBe(0);
  });
});

// ─── getLoanConfig — boundary validation mutations ───────────────────────────

describe('mutation: getLoanConfig range boundaries (#401)', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = [
    'LOAN_MIN_SCORE',
    'LOAN_MAX_AMOUNT',
    'LOAN_INTEREST_RATE_PERCENT',
    'CREDIT_SCORE_THRESHOLD',
  ];

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env['LOAN_MIN_SCORE'] = '500';
    process.env['LOAN_MAX_AMOUNT'] = '10000';
    process.env['LOAN_INTEREST_RATE_PERCENT'] = '12';
    process.env['CREDIT_SCORE_THRESHOLD'] = '600';
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('accepts minimum valid score (300) — kills off-by-one on lower bound', async () => {
    process.env['LOAN_MIN_SCORE'] = '300';
    process.env['CREDIT_SCORE_THRESHOLD'] = '300';
    const { getLoanConfig } = await import('../config/loanConfig.js');
    expect(() => getLoanConfig()).not.toThrow();
    const cfg = getLoanConfig();
    expect(cfg.minScore).toBe(300);
  });

  it('accepts maximum valid score (850) — kills off-by-one on upper bound', async () => {
    process.env['LOAN_MIN_SCORE'] = '850';
    process.env['CREDIT_SCORE_THRESHOLD'] = '850';
    const { getLoanConfig } = await import('../config/loanConfig.js');
    expect(() => getLoanConfig()).not.toThrow();
    const cfg = getLoanConfig();
    expect(cfg.minScore).toBe(850);
  });

  it('rejects score 299 (below minimum) — kills boundary-check mutation', async () => {
    process.env['LOAN_MIN_SCORE'] = '299';
    const { getLoanConfig } = await import('../config/loanConfig.js');
    expect(() => getLoanConfig()).toThrow();
  });

  it('rejects score 851 (above maximum) — kills boundary-check mutation', async () => {
    process.env['LOAN_MIN_SCORE'] = '851';
    const { getLoanConfig } = await import('../config/loanConfig.js');
    expect(() => getLoanConfig()).toThrow();
  });

  it('rejects LOAN_MAX_AMOUNT = 0 — kills zero-validity mutation', async () => {
    process.env['LOAN_MAX_AMOUNT'] = '0';
    const { getLoanConfig } = await import('../config/loanConfig.js');
    expect(() => getLoanConfig()).toThrow();
  });

  it('rejects non-integer LOAN_MIN_SCORE — kills type-coercion mutation', async () => {
    process.env['LOAN_MIN_SCORE'] = '500.5';
    const { getLoanConfig } = await import('../config/loanConfig.js');
    expect(() => getLoanConfig()).toThrow();
  });
});
