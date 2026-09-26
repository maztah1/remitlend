//! Commission invariant tests for the LendingPool contract.
//!
//! # Security context — issue #356
//!
//! The pool uses a share-based (ERC-4626-style) accounting model with
//! `TotalManagedAssets` as the single source of truth for share pricing.
//! Yield is realised by calling `distribute_yield`, which is the *only*
//! authorised way to increase managed assets outside of a deposit.
//!
//! ## Economic attack vectors covered
//!
//! | ID     | Attack                                | Guard                                       |
//! |--------|---------------------------------------|---------------------------------------------|
//! | ATK-1  | Share-price inflation via donation    | `TotalManagedAssets` never reads live balance; virtual shares/assets offset prevents rounding-to-zero |
//! | ATK-2  | Late-join extraction of pre-existing yield | Yield is baked into the share price at deposit time, not credited separately |
//! | ATK-3  | Flashloan-driven pool drain            | `VIRTUAL_SHARES`/`VIRTUAL_ASSETS` offset (1_000 each) makes single-block manipulation economically impractical |
//! | ATK-4  | Unauthorised yield injection           | `distribute_yield` requires admin auth; price event emitted for auditability |
//! | ATK-5  | Withdrawal cooldown bypass             | Cooldown checked against per-(provider, token) deposit timestamp, not wall-clock |
//! | ATK-6  | Deposit to frozen pool                 | Granular pause flags gate deposits/withdrawals/yield independently |
//!
//! ## Invariants under test
//!
//! * INV-LP-1  Share price never decreases across deposit/withdraw round-trips.
//! * INV-LP-2  A donation (direct token transfer) cannot move the share price.
//! * INV-LP-3  Late depositors cannot extract yield distributed before their entry.
//! * INV-LP-4  Granular pause flags independently block the correct operations.
//! * INV-LP-5  `TotalManagedAssets` matches the pool's actual token balance.
//! * INV-LP-6  Slippage guards (`min_shares_out`, `min_assets_out`) reject adverse price moves.

use crate::{LendingPool, LendingPoolClient};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::token::{Client as TokenClient, StellarAssetClient};
use soroban_sdk::{Address, Env};

// ── Test helpers ──────────────────────────────────────────────────────────────

fn setup(
    env: &Env,
) -> (
    LendingPoolClient<'_>,
    Address,
    StellarAssetClient<'_>,
    TokenClient<'_>,
) {
    env.mock_all_auths();
    let admin = Address::generate(env);
    let pool_id = env.register(LendingPool, ());
    let pool = LendingPoolClient::new(env, &pool_id);
    pool.initialize(&admin);
    // Disable withdrawal cooldown so we can withdraw in the same ledger.
    pool.set_withdrawal_cooldown(&0);

    let token_admin = Address::generate(env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token = token_contract.address();
    let sa_client = StellarAssetClient::new(env, &token);
    let token_client = TokenClient::new(env, &token);

    (pool, token, sa_client, token_client)
}

fn mint(sa: &StellarAssetClient, to: &Address, amount: i128) {
    sa.mint(to, &amount);
}

// ── INV-LP-1: share price never decreases during deposit/withdraw cycles ──────
//
// After N deposit → withdraw round-trips the share price must never be lower
// than it was at the start.  Rounding is always in the *pool's* favour (floor),
// so residual dust stays in the pool for existing holders rather than leaking.
#[test]
fn inv_lp1_share_price_non_decreasing_under_deposits_and_withdrawals() {
    let env = Env::default();
    let (pool, token, sa, tc) = setup(&env);

    let provider_a = Address::generate(&env);
    let provider_b = Address::generate(&env);
    mint(&sa, &provider_a, 100_000);
    mint(&sa, &provider_b, 100_000);

    // First deposit — establishes the initial 1:1 share price (modulo virtual offsets).
    pool.deposit(&provider_a, &token, &50_000, &0);
    let price_after_first = pool.get_pool_stats(&token).total_managed_assets;
    let shares_after_first = pool.get_pool_stats(&token).total_shares;
    assert!(price_after_first > 0);
    assert!(shares_after_first > 0);

    // Second depositor joins.
    pool.deposit(&provider_b, &token, &50_000, &0);

    // Provider A withdraws all shares.
    let shares_a = pool.get_shares(&provider_a, &token);
    pool.withdraw(&provider_a, &token, &shares_a, &0);

    // Share price must not have dropped for remaining holder B.
    let stats_after = pool.get_pool_stats(&token);
    // We use cross-multiplication to avoid floating point:
    //   price_after_first / shares_after_first <= stats_after.total_managed_assets / stats_after.total_shares
    let lhs = price_after_first * stats_after.total_shares;
    let rhs = stats_after.total_managed_assets * shares_after_first;
    assert!(
        lhs <= rhs,
        "share price decreased: initial_managed/shares={}/{} final_managed/shares={}/{}",
        price_after_first,
        shares_after_first,
        stats_after.total_managed_assets,
        stats_after.total_shares,
    );

    // The pool's actual token balance must equal tracked managed assets
    // (no idle tokens escaped bookkeeping).
    assert_eq!(
        tc.balance(&pool.address),
        stats_after.total_managed_assets,
        "pool balance diverged from tracked managed assets after withdraw cycle",
    );
}

// ── INV-LP-2: donation attack — direct token transfer cannot move the share price
//
// An attacker who transfers tokens directly to the pool address (bypassing
// `deposit`) must NOT be able to inflate or deflate the share price seen by
// other depositors.  The pool never reads `token::balance` for share pricing;
// it reads `TotalManagedAssets`.
#[test]
fn inv_lp2_donation_cannot_inflate_share_price() {
    let env = Env::default();
    let (pool, token, sa, tc) = setup(&env);

    let victim = Address::generate(&env);
    let attacker = Address::generate(&env);
    mint(&sa, &victim, 10_000);
    mint(&sa, &attacker, 100_000);

    // Victim deposits first to receive shares.
    pool.deposit(&victim, &token, &10_000, &0);
    let shares_victim = pool.get_shares(&victim, &token);
    let managed_before = pool.get_pool_stats(&token).total_managed_assets;

    // Attacker donates directly — token transfer to pool address, NOT via deposit.
    tc.transfer(&attacker, &pool.address, &90_000);

    // The pool's live balance jumped, but TotalManagedAssets must be unchanged.
    let managed_after = pool.get_pool_stats(&token).total_managed_assets;
    assert_eq!(
        managed_before, managed_after,
        "donation changed TotalManagedAssets from {} to {} (ATK-1 violation)",
        managed_before, managed_after,
    );

    // The victim's redeemable assets must equal their original deposit (no inflation).
    let redeemable = pool.get_deposit(&victim, &token);
    assert_eq!(
        redeemable, 10_000,
        "donation changed victim's redeemable value from 10_000 to {} (ATK-1 violation)",
        redeemable,
    );

    // Victim can still withdraw their full deposit.
    pool.withdraw(&victim, &token, &shares_victim, &0);
    assert!(
        tc.balance(&victim) >= 10_000,
        "victim received less than their deposit back after donation attack",
    );
}

// ── INV-LP-3: late-join yield isolation ──────────────────────────────────────
//
// Yield distributed before a depositor joins must NOT accrue to that depositor.
// The share price captures existing yield; the late depositor pays the current
// (higher) price per share, so they receive only yield earned *after* their entry.
#[test]
fn inv_lp3_late_depositor_cannot_extract_pre_existing_yield() {
    let env = Env::default();
    let (pool, token, sa, _tc) = setup(&env);

    let early = Address::generate(&env);
    let late_joiner = Address::generate(&env);
    let yield_source = Address::generate(&env);
    mint(&sa, &early, 100_000);
    mint(&sa, &late_joiner, 100_000);
    mint(&sa, &yield_source, 50_000);

    // Early depositor.
    pool.deposit(&early, &token, &100_000, &0);
    let shares_early = pool.get_shares(&early, &token);
    let managed_before_yield = pool.get_pool_stats(&token).total_managed_assets;

    // Yield is distributed to the pool (admin-only, auth mocked).
    pool.distribute_yield(&yield_source, &token, &50_000);
    let managed_after_yield = pool.get_pool_stats(&token).total_managed_assets;
    assert_eq!(
        managed_after_yield,
        managed_before_yield + 50_000,
        "yield distribution did not increase managed assets correctly",
    );

    // Late depositor joins AFTER yield was distributed.
    pool.deposit(&late_joiner, &token, &100_000, &0);
    let shares_late = pool.get_shares(&late_joiner, &token);

    // Late depositor must receive fewer shares than early depositor for the
    // same deposit amount, because the share price is now higher.
    assert!(
        shares_late < shares_early,
        "late depositor received >= shares as early depositor ({} >= {}); \
        they would be able to extract pre-existing yield (ATK-2 violation)",
        shares_late,
        shares_early,
    );

    // Early depositor's redeemable assets must include their share of the yield.
    let early_redeemable = pool.get_deposit(&early, &token);
    assert!(
        early_redeemable > 100_000,
        "early depositor did not receive yield: redeemable {} <= deposit 100_000",
        early_redeemable,
    );

    // Late depositor's redeemable assets must be ≈ their deposit (not including early yield).
    // Allow 1-stroop rounding tolerance.
    let late_redeemable = pool.get_deposit(&late_joiner, &token);
    assert!(
        late_redeemable <= 100_001,
        "late depositor extracted pre-existing yield: redeemable {} > deposit 100_001 (ATK-2)",
        late_redeemable,
    );
}

// ── INV-LP-4: granular pause flags gate the correct operations ────────────────
//
// Deposit pause must reject deposits but still allow withdrawals.
// Withdrawal pause must reject withdrawals but still allow deposits.
#[test]
fn inv_lp4_granular_pause_gates_correct_operations() {
    let env = Env::default();
    let (pool, token, sa, _tc) = setup(&env);

    let provider = Address::generate(&env);
    mint(&sa, &provider, 500_000);

    // Seed an initial deposit so withdrawals have something to redeem.
    pool.deposit(&provider, &token, &100_000, &0);
    let initial_shares = pool.get_shares(&provider, &token);

    // --- Pause deposits only ---
    pool.set_pause_flags(&true, &false, &false);

    // Deposit must be rejected.
    let deposit_result = pool.try_deposit(&provider, &token, &1_000, &0);
    assert!(
        deposit_result.is_err(),
        "deposit succeeded while deposits are paused (ATK-6 violation)",
    );

    // Withdrawal must still succeed.
    let withdraw_result = pool.try_withdraw(&provider, &token, &(initial_shares / 2), &0);
    assert!(
        withdraw_result.is_ok(),
        "withdraw failed while only deposits are paused: {:?}",
        withdraw_result,
    );

    // --- Unpause deposits, pause withdrawals ---
    pool.set_pause_flags(&false, &true, &false);

    let deposit_result2 = pool.try_deposit(&provider, &token, &1_000, &0);
    assert!(
        deposit_result2.is_ok(),
        "deposit failed while only withdrawals are paused: {:?}",
        deposit_result2,
    );

    let remaining_shares = pool.get_shares(&provider, &token);
    let withdraw_result2 = pool.try_withdraw(&provider, &token, &remaining_shares, &0);
    assert!(
        withdraw_result2.is_err(),
        "withdraw succeeded while withdrawals are paused (ATK-6 violation)",
    );

    // --- Full unpause ---
    pool.set_pause_flags(&false, &false, &false);
    let final_shares = pool.get_shares(&provider, &token);
    let withdraw_result3 = pool.try_withdraw(&provider, &token, &final_shares, &0);
    assert!(
        withdraw_result3.is_ok(),
        "withdraw failed after full unpause: {:?}",
        withdraw_result3,
    );
}

// ── INV-LP-5: total managed assets accounting is exact ───────────────────────
//
// After any combination of deposit → yield → partial-withdraw operations,
// `TotalManagedAssets` must equal the pool's actual token balance.  Since the
// test environment has no outstanding loans, idle balance == managed assets.
#[test]
fn inv_lp5_total_managed_assets_matches_pool_balance() {
    let env = Env::default();
    let (pool, token, sa, tc) = setup(&env);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let yield_src = Address::generate(&env);
    mint(&sa, &p1, 200_000);
    mint(&sa, &p2, 150_000);
    mint(&sa, &yield_src, 30_000);

    pool.deposit(&p1, &token, &200_000, &0);
    pool.deposit(&p2, &token, &150_000, &0);
    pool.distribute_yield(&yield_src, &token, &30_000);

    let s2 = pool.get_shares(&p2, &token);
    pool.withdraw(&p2, &token, &(s2 / 3), &0);

    let stats = pool.get_pool_stats(&token);
    let live_balance = tc.balance(&pool.address);

    assert_eq!(
        stats.total_managed_assets, live_balance,
        "TotalManagedAssets ({}) diverged from live pool balance ({}) (INV-LP-5)",
        stats.total_managed_assets, live_balance,
    );
}

// ── INV-LP-6: min_shares_out / min_assets_out slippage guards ────────────────
//
// If the share price moves adversely between the moment a user computes their
// expected output and when the transaction lands, the slippage parameter must
// cause the call to revert rather than settle at a worse price.
#[test]
fn inv_lp6_slippage_guard_rejects_adverse_price_move_on_deposit() {
    let env = Env::default();
    let (pool, token, sa, _tc) = setup(&env);

    let p1 = Address::generate(&env);
    let p2 = Address::generate(&env);
    let yield_src = Address::generate(&env);
    mint(&sa, &p1, 100_000);
    mint(&sa, &p2, 100_000);
    mint(&sa, &yield_src, 200_000);

    // Establish initial price.
    pool.deposit(&p1, &token, &100_000, &0);
    let shares_p1 = pool.get_shares(&p1, &token);

    // P2 simulates: "I expect at least shares_p1 - 1 shares for my 100_000 deposit."
    // Before the tx lands, a large yield distribution inflates the share price,
    // so 100_000 tokens now buy fewer shares than expected.
    pool.distribute_yield(&yield_src, &token, &200_000);

    // P2's deposit with the now-stale high min_shares_out must revert.
    let result = pool.try_deposit(&p2, &token, &100_000, &(shares_p1 - 1));
    assert!(
        result.is_err(),
        "deposit succeeded despite adverse share price move; slippage guard failed (INV-LP-6)",
    );

    // P2 can still deposit with min_shares_out = 0 (no slippage limit).
    let result2 = pool.try_deposit(&p2, &token, &100_000, &0);
    assert!(
        result2.is_ok(),
        "deposit without slippage limit failed unexpectedly: {:?}",
        result2,
    );
}
