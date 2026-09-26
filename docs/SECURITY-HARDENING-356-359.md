# Security Hardening — Issues #356, #357, #358, #359

This document describes the security controls implemented to address four
security issues filed against RemitLend. It serves as the threat-model notes,
compatibility impact assessment, rollout steps, and verification evidence
required by each issue's acceptance criteria.

---

## Issue #356 — Commission invariant-based economic attack review

### What was the issue?

The LendingPool contract uses a share-based (ERC-4626-style) accounting model
with `TotalManagedAssets` as the single source of truth for share pricing. No
automated tests verified that the economic invariants hold across adversarial
scenarios (donation attacks, flashloan manipulation, late-join yield extraction).

### Changes made

| File | Change |
|---|---|
| `contracts/lending_pool/src/commission_invariants.rs` | New: 6 deterministic invariant tests (INV-LP-1 through INV-LP-6) |
| `contracts/lending_pool/src/lib.rs` | Added `mod commission_invariants` declaration |
| `backend/src/__tests__/commissionInvariants.test.ts` | New: API-layer fee arithmetic and share-price tests |

### Invariants tested

| ID | Invariant | Attack mitigated |
|---|---|---|
| INV-LP-1 | Share price is non-decreasing across deposit/withdraw cycles | Rounding-direction exploit |
| INV-LP-2 | Donation (direct token transfer) cannot move TotalManagedAssets | ATK-1: share-price inflation via donation |
| INV-LP-3 | Late depositors cannot extract yield distributed before their entry | ATK-2: late-join yield extraction |
| INV-LP-4 | Granular pause flags gate only their declared operations | ATK-6: operation bypass via partial pause |
| INV-LP-5 | TotalManagedAssets equals pool balance when no loans are outstanding | Accounting divergence |
| INV-LP-6 | Slippage guards reject adverse share-price moves | Front-running / MEV |
| INV-API-1 | fee(0) == 0 for all rates | Zero-principal drain |
| INV-API-2 | Fee never exceeds principal × MAX_RATE_BPS / 10_000 | Integer overflow |
| INV-API-3 | Fee config parameters are bounded by their on-chain caps | Admin parameter abuse |
| INV-API-4 | Deposit → immediate withdraw returns ≤ deposited amount | Round-trip profit |
| INV-API-5 | Extension fee is bounded by EXTENSION_FEE_BPS × remaining principal | Fee inflation |

### Compatibility impact

Tests-only change. No production code paths are modified. Existing contract
deployments are unaffected.

### Rollout

Tests run automatically on every PR and push to `main` via the `contracts` and
`backend` CI jobs.

---

## Issue #357 — Complete API abuse-case matrix and rate-limit policy

### What was the issue?

The rate-limiting configuration existed in `rateLimiter.ts` but there was no
documented mapping from each abuse case to its specific rate-limiter, and no
tests asserting that each dangerous endpoint group was covered with the correct
window and max-request settings.

### Changes made

| File | Change |
|---|---|
| `backend/src/__tests__/apiAbuseCaseMatrix.test.ts` | New: 12-case abuse matrix with rate-limit configuration assertions |

### Abuse cases covered

| ID | Vector | Endpoint | Limiter | Window | Max |
|---|---|---|---|---|---|
| AC-1 | Brute-force challenge nonce | POST /api/auth/challenge | `challengeRateLimiter` | 1 min | 10 |
| AC-2 | Credential stuffing | POST /api/auth/login | `loginRateLimiter` + `ipLoginRateLimiter` | 1 min | 5 |
| AC-3 | Token-validation DoS | GET /api/auth/verify | `verifyRateLimiter` | 1 min | 10 |
| AC-4 | Simulation flooding | POST /api/simulate/* | `simulationRateLimiter` | 1 min | 5 |
| AC-5 | Score-update farming | POST /api/score/update | `scoreUpdateRateLimit` | 24 h | 5 |
| AC-6 | Admin endpoint enumeration | /api/admin/* | `strictRateLimiter` | 45 min | 10 |
| AC-7 | Global API flooding | All endpoints | `globalRateLimiter` | 15 min | 100 |
| AC-8 | Oversized payload DoS | Any POST/PATCH | `express.json({ limit: '100kb' })` | — | 100 KB |
| AC-9 | CSRF | Authenticated routes | CORS + `SameSite=strict` cookie | — | — |
| AC-10 | JWT-less privileged access | Scoped routes | `requireJwtAuth` / `requireApiKey` | — | — |
| AC-11 | Score-update replay | POST /api/score/update | Idempotency key + Redis dedupe | — | — |
| AC-12 | Pagination parameter abuse | GET /api/loans/* | Validated limit/offset (max 100) | — | — |

### Compatibility impact

Tests-only change. Rate-limiter values are read from the existing production
instances; no configuration was changed.

### Rollout

Tests run automatically via the `backend` CI job on every PR.

---

## Issue #358 — Audit wallet signing UX for confused-deputy attacks

### What was the issue?

The wallet signing flow (XDR builders + `TransactionPreviewModal`) had no
automated tests verifying that the encoded contract address, function name,
amounts, borrower address, network passphrase, and transaction timeout exactly
match the values shown to the user before signing.

### Changes made

| File | Change |
|---|---|
| `frontend/src/app/utils/confusedDeputy.test.ts` | New: 14 tests covering all 7 confused-deputy vectors |

### Vectors audited

| ID | Attack | Guard | Test |
|---|---|---|---|
| CD-1 | Contract address substitution | XDR built with `contractId`; different IDs produce different XDRs | ✅ |
| CD-2 | Function name mismatch | Function name decoded from XDR and asserted | ✅ |
| CD-3 | Amount substitution | Amount ScVal decoded and compared to input | ✅ |
| CD-4 | Borrower address substitution | Borrower ScVal decoded and compared to signer | ✅ |
| CD-5 | Network passphrase mismatch | Testnet and mainnet hashes diverge | ✅ |
| CD-6 | Transaction replay (stale XDR) | Timeout ≤ 300 s asserted on every unsigned XDR | ✅ |
| CD-7 | Fee escalation | `buildUnsigned*Xdr` hard-codes fee=10_000 stroops | ✅ (via CD-2 XDR inspection) |

### Existing mitigations confirmed

- `TransactionPreviewModal` shows `network`, `contractAddress`, operation type,
  amount, and token before the user signs.
- `useTransactionPreview` keeps the modal open on error so users can retry or
  inspect before re-signing.
- `buildUnsignedLoanRequestXdr` and `buildUnsignedRepaymentXdr` call
  `.setTimeout(300)` on every transaction, limiting the replay window.

### Compatibility impact

Tests-only change. No production frontend code is modified.

### Rollout

Tests run automatically via the `frontend` CI job on every PR.

---

## Issue #359 — Secrets inventory and automated exposure scanning

### What was the issue?

There was no centralised inventory of all secrets used across the stack, no
documented rotation policy, and no CI job that would catch accidentally
committed secrets or placeholder values left in code.

### Changes made

| File | Change |
|---|---|
| `docs/SECRETS-INVENTORY.md` | New: canonical inventory with classification, rotation policy, and emergency response |
| `.gitleaks.toml` | New: gitleaks configuration with project-specific allow-list for CI/test placeholders |
| `.github/workflows/ci.yml` | Added `secrets-scan` job using `gitleaks/gitleaks-action@v2` + grep heuristics |
| `backend/src/__tests__/secretsInventory.test.ts` | New: runtime assertions that secrets are not logged, leaked in responses, or set to placeholder values |

### Secrets inventoried

See [docs/SECRETS-INVENTORY.md](SECRETS-INVENTORY.md) for the complete table.
High-risk secrets:

- `JWT_SECRET` — forged tokens → full account takeover
- `INTERNAL_API_KEY` — admin API bypass
- `LOAN_MANAGER_ADMIN_SECRET` — on-chain admin control

### CI job behaviour

The `secrets-scan` job:

1. Checks out the **full git history** (`fetch-depth: 0`) so past commits are scanned.
2. Runs `gitleaks detect` with the default ruleset plus project-specific allow-list.
3. Runs a grep-based heuristic scan for known placeholder values.
4. Fails the build if any match is found outside documented allow-list entries.

`.env.example` files are excluded from the grep scan because they are permitted
to contain placeholder documentation values.

### Compatibility impact

The `secrets-scan` job is additive. Existing CI jobs are not modified.
The `.gitleaks.toml` allow-list entries prevent false positives on the
test-fixture values already committed in `ci.yml`.

### Rollout

1. Merge this PR — the `secrets-scan` job activates on the next push.
2. Rotate any secrets that are currently set to placeholder values in staging/production.
3. Fill in the "Last rotated" table in `docs/SECRETS-INVENTORY.md`.

---

## Verification evidence

| Issue | How to verify |
|---|---|
| #356 | `cd contracts && cargo test -p lending_pool commission_invariants` and `cd backend && npm test -- commissionInvariants` |
| #357 | `cd backend && npm test -- apiAbuseCaseMatrix` |
| #358 | `cd frontend && npm test -- confusedDeputy` |
| #359 | `cd backend && npm test -- secretsInventory`; inspect `secrets-scan` job in GitHub Actions |
