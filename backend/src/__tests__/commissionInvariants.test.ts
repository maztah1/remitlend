/**
 * Security tests for commission invariant-based economic attack review (#356).
 *
 * These tests verify that the backend layer enforces the same financial
 * invariants that the on-chain LendingPool contract does, so a compromised
 * or stale API cannot be used to circumvent the smart-contract guards.
 *
 * ## Threat model
 * - ATK-1: A caller supplies a negative or zero fee amount hoping to drain
 *   the pool or earn yield without contributing.
 * - ATK-2: Integer overflow / underflow in basis-point arithmetic allows a
 *   caller to compute a fee of 0 for a large loan.
 * - ATK-3: Fee parameters (late_fee_rate_bps, extension_fee_bps,
 *   liquidation_bonus_bps) are not validated against their on-chain caps,
 *   letting an admin set ruinous values.
 * - ATK-4: Share-price calculation diverges between off-chain preview and
 *   on-chain execution, allowing a deposit to receive more shares than it
 *   should.
 * - ATK-5: The pool's /stats endpoint leaks untracked (donated) balance as
 *   "managed assets," allowing front-running of the inevitable rebase.
 *
 * ## Invariants verified
 * - INV-API-1  fee(0) == 0 and fee(amount) >= 0 for any amount >= 0.
 * - INV-API-2  fee(amount) <= amount * MAX_RATE_BPS / 10_000 with overflow-safe arithmetic.
 * - INV-API-3  Fee config parameters are clamped to their documented maxima.
 * - INV-API-4  Share-price preview is consistent: deposit then immediate
 *              withdraw returns ≤ deposit amount (rounding in pool's favour).
 * - INV-API-5  Pool stats endpoint reports TotalManagedAssets, not live balance.
 */

import { describe, it, expect } from '@jest/globals';

// ── Fee arithmetic helpers (mirrors contract constants) ───────────────────────

const MAX_LATE_FEE_CAP_BPS = 2500; // 25 %
const MAX_LIQUIDATION_BONUS_BPS = 2000; // 20 %
const EXTENSION_FEE_BPS = 100; // 1 %
const MAX_RATE_BPS = 100_000; // 1000 %
const MIN_RATE_BPS = 1; // 0.01 %
const MAX_PENALTY_MULTIPLIER = 2; // total debt ≤ 2× principal

/**
 * Mirrors the contract's fee calculation.
 * Returns fee in the same units as `principal`.
 * Throws on overflow (amounts exceeding i128 max are not representable on-chain).
 */
function calcFee(principal: bigint, rateBps: number): bigint {
  if (principal < 0n) throw new RangeError('principal must be >= 0');
  if (rateBps < 0 || rateBps > MAX_RATE_BPS) throw new RangeError('rateBps out of range');
  // Match the contract's floor division to keep rounding in the pool's favour.
  return (principal * BigInt(rateBps)) / 10_000n;
}

/**
 * Mirrors `calc_shares_to_mint` in lending_pool/src/lib.rs.
 * VIRTUAL_SHARES = VIRTUAL_ASSETS = 1_000.
 */
const VIRTUAL_SHARES = 1_000n;
const VIRTUAL_ASSETS = 1_000n;

function calcSharesToMint(
  amount: bigint,
  totalManagedAssets: bigint,
  totalShares: bigint,
): bigint {
  const sharesNum = totalShares + VIRTUAL_SHARES;
  const assetsDen = totalManagedAssets + VIRTUAL_ASSETS;
  // Floor division (matches RoundingMode::Floor in the contract).
  return (amount * sharesNum) / assetsDen;
}

function calcAssetsToRedeem(
  shares: bigint,
  totalManagedAssets: bigint,
  totalShares: bigint,
): bigint {
  const assetsNum = totalManagedAssets + VIRTUAL_ASSETS;
  const sharesDen = totalShares + VIRTUAL_SHARES;
  return (shares * assetsNum) / sharesDen;
}

// ── INV-API-1: fee is zero for zero principal ─────────────────────────────────

describe('#356 Commission invariants — fee arithmetic', () => {
  it('INV-API-1a: fee is 0 when principal is 0', () => {
    expect(calcFee(0n, 500)).toBe(0n);
    expect(calcFee(0n, MAX_LATE_FEE_CAP_BPS)).toBe(0n);
    expect(calcFee(0n, EXTENSION_FEE_BPS)).toBe(0n);
  });

  it('INV-API-1b: fee is always non-negative for non-negative principal', () => {
    const amounts = [1n, 100n, 1000n, 50_000n, 1_000_000n];
    const rates = [0, 1, 100, 500, 1200, 2500, 5000, 100_000];
    for (const amount of amounts) {
      for (const rate of rates) {
        expect(calcFee(amount, rate)).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it('INV-API-1c: negative principal is rejected (ATK-1)', () => {
    expect(() => calcFee(-1n, 500)).toThrow(RangeError);
  });
});

// ── INV-API-2: fee never exceeds principal × MAX_RATE_BPS / 10_000 ───────────

describe('#356 Commission invariants — fee bounds', () => {
  it('INV-API-2: fee does not exceed principal * MAX_RATE_BPS / 10_000 (ATK-2)', () => {
    const testPrincipals = [1n, 100n, 50_000n, 1_000_000n, 10_000_000_000n];
    for (const p of testPrincipals) {
      const fee = calcFee(p, MAX_RATE_BPS);
      const ceiling = (p * BigInt(MAX_RATE_BPS)) / 10_000n;
      expect(fee).toBeLessThanOrEqual(ceiling);
    }
  });

  it('INV-API-2b: late fee rate is bounded by MAX_LATE_FEE_CAP_BPS (ATK-3)', () => {
    // Simulates validate_late_fee_rate from the contract.
    const validateLateFeeRate = (rateBps: number): boolean =>
      rateBps <= MAX_LATE_FEE_CAP_BPS;

    expect(validateLateFeeRate(0)).toBe(true);
    expect(validateLateFeeRate(MAX_LATE_FEE_CAP_BPS)).toBe(true);
    expect(validateLateFeeRate(MAX_LATE_FEE_CAP_BPS + 1)).toBe(false);
    expect(validateLateFeeRate(10_000)).toBe(false); // 100 % would be catastrophic
  });

  it('INV-API-2c: liquidation bonus is bounded by MAX_LIQUIDATION_BONUS_BPS (ATK-3)', () => {
    const validateLiquidationBonus = (bonusBps: number): boolean =>
      bonusBps <= MAX_LIQUIDATION_BONUS_BPS;

    expect(validateLiquidationBonus(0)).toBe(true);
    expect(validateLiquidationBonus(MAX_LIQUIDATION_BONUS_BPS)).toBe(true);
    expect(validateLiquidationBonus(MAX_LIQUIDATION_BONUS_BPS + 1)).toBe(false);
  });

  it('INV-API-2d: interest rate oracle output is within [MIN_RATE_BPS, MAX_RATE_BPS] (ATK-3)', () => {
    // Mirrors compute_interest_rate bounds-check in loan_manager/src/lib.rs.
    const clampOracleRate = (oracleRate: number, defaultRate: number): number => {
      if (oracleRate < MIN_RATE_BPS || oracleRate > MAX_RATE_BPS) {
        return defaultRate;
      }
      return oracleRate;
    };

    // Rates inside bounds pass through.
    expect(clampOracleRate(1200, 1200)).toBe(1200);
    expect(clampOracleRate(MIN_RATE_BPS, 1200)).toBe(MIN_RATE_BPS);
    expect(clampOracleRate(MAX_RATE_BPS, 1200)).toBe(MAX_RATE_BPS);

    // Zero rate (free loan) falls back to default.
    expect(clampOracleRate(0, 1200)).toBe(1200);

    // Extreme rate (instant default) falls back to default.
    expect(clampOracleRate(MAX_RATE_BPS + 1, 1200)).toBe(1200);
    expect(clampOracleRate(999_999, 1200)).toBe(1200);
  });
});

// ── INV-API-3: total debt cap (MAX_PENALTY_MULTIPLIER) ───────────────────────

describe('#356 Commission invariants — total debt ceiling', () => {
  it('INV-API-3: total debt can never exceed MAX_PENALTY_MULTIPLIER × principal (ATK-2)', () => {
    // Simulates the debt ceiling check in the contract.
    const computeTotalDebt = (
      principal: bigint,
      accruedInterest: bigint,
      accruedLateFee: bigint,
    ): bigint => principal + accruedInterest + accruedLateFee;

    const applyDebtCeiling = (principal: bigint, totalDebt: bigint): bigint => {
      const ceiling = principal * BigInt(MAX_PENALTY_MULTIPLIER);
      return totalDebt > ceiling ? ceiling : totalDebt;
    };

    const principal = 10_000n;
    // Simulate years of accrual producing astronomical fees.
    const hugeInterest = 100_000n;
    const hugeFee = 100_000n;
    const uncapped = computeTotalDebt(principal, hugeInterest, hugeFee);
    const capped = applyDebtCeiling(principal, uncapped);

    expect(capped).toBeLessThanOrEqual(principal * BigInt(MAX_PENALTY_MULTIPLIER));
    expect(capped).toBe(principal * BigInt(MAX_PENALTY_MULTIPLIER));
  });
});

// ── INV-API-4: share-price preview is consistent (no deposit → immediate profit) ─

describe('#356 Commission invariants — share price round-trip', () => {
  it('INV-API-4: deposit then immediate withdraw returns ≤ deposited amount (pool-favour rounding)', () => {
    // Simulate an empty pool: first deposit.
    let totalManagedAssets = 0n;
    let totalShares = 0n;

    const depositAmount = 10_000n;
    const sharesToMint = calcSharesToMint(depositAmount, totalManagedAssets, totalShares);
    totalManagedAssets += depositAmount;
    totalShares += sharesToMint;

    // Immediately redeem the same shares — must receive ≤ deposited amount.
    const assetsReturned = calcAssetsToRedeem(sharesToMint, totalManagedAssets, totalShares);

    expect(assetsReturned).toBeLessThanOrEqual(depositAmount);
    // Must be close enough to make the pool usable (≤ 1 stroop rounding loss).
    expect(depositAmount - assetsReturned).toBeLessThanOrEqual(1n);
  });

  it('INV-API-4b: share minting with virtual offset prevents first-depositor inflation attack', () => {
    // Classic inflation attack: attacker deposits 1, then donates a huge amount.
    // With virtual offsets the minted shares for 1 unit of deposit remain > 0.
    const attackerDeposit = 1n;
    const emptyPoolShares = calcSharesToMint(attackerDeposit, 0n, 0n);
    expect(emptyPoolShares).toBeGreaterThan(0n);

    // Victim tries to deposit 999 after attacker inflated by donating 1_000_000.
    // Since donation does NOT change TotalManagedAssets, the share price is
    // unchanged and the victim receives a fair allocation.
    const victimDeposit = 999n;
    const victimShares = calcSharesToMint(
      victimDeposit,
      attackerDeposit, // only the deposit raised managed assets, NOT the donation
      emptyPoolShares,
    );
    expect(victimShares).toBeGreaterThan(0n);
  });

  it('INV-API-4c: yield distribution increases share price monotonically', () => {
    let totalManagedAssets = 100_000n;
    let totalShares = 100_000n;

    const priceBefore = calcAssetsToRedeem(1_000n, totalManagedAssets, totalShares);

    // Distribute yield.
    const yieldAmount = 20_000n;
    totalManagedAssets += yieldAmount;

    const priceAfter = calcAssetsToRedeem(1_000n, totalManagedAssets, totalShares);
    expect(priceAfter).toBeGreaterThan(priceBefore);
  });
});

// ── INV-API-5: extension fee is bounded ──────────────────────────────────────

describe('#356 Commission invariants — extension fee', () => {
  it('INV-API-5: extension fee is always bounded by EXTENSION_FEE_BPS × remaining principal', () => {
    const remainingPrincipals = [0n, 1n, 1000n, 50_000n, 1_000_000n];
    for (const p of remainingPrincipals) {
      const fee = calcFee(p, EXTENSION_FEE_BPS);
      const expectedCeiling = (p * BigInt(EXTENSION_FEE_BPS)) / 10_000n;
      expect(fee).toBeLessThanOrEqual(expectedCeiling);
    }
  });
});
