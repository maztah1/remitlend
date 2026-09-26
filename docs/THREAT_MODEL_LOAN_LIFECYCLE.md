# Loan Lifecycle Threat Model

This threat model covers the complete RemitLend loan lifecycle: onboarding,
loan creation, funding, repayment, default handling, liquidation, and closure.
It complements [SECURITY-MODEL.md](./SECURITY-MODEL.md), which defines the
authentication and authorization controls.

## Scope and trust boundaries

| Boundary | Assets | Primary controls |
|---|---|---|
| Borrower or lender wallet | Private keys, signatures, transaction intent | Wallet confirmation, transaction preview, address validation |
| Frontend and browser | Session token, PII, pending transaction context | CSP nonce, HTTPS, bounded session recovery state, no private keys |
| Backend API | JWTs, API keys, loan commands, PII | JWT verification, scope guards, rate limits, input validation, audit logs |
| Database and job workers | Loan state, repayment events, webhook secrets | Parameterized queries, idempotency keys, encrypted secrets, transaction boundaries |
| Stellar network and contracts | Funds, loan state, authorization rules | Contract authorization, checked arithmetic, pause controls, event reconciliation |
| External providers | RPC, wallet, notification and monitoring responses | Timeouts, retries only for reads, signature verification, degraded-mode handling |

## Lifecycle analysis

| Phase | Threat | Impact | Required mitigation and detection |
|---|---|---|---|
| Onboarding | Forged wallet challenge or replayed signature | Account takeover | One-time, expiring challenges; bind verification to the requested public key; audit failed attempts |
| Onboarding | JWT theft or stale browser session | Unauthorized API access | Short-lived JWTs, secure cookie flags, bearer validation, session-expiry recovery that never persists tokens |
| Loan creation | Unauthorized borrower or parameter tampering | Fraudulent loan or loss of funds | Scope and ownership checks; server-side amount, currency, collateral, and term validation; idempotency key |
| Loan creation | Duplicate submission after timeout | Duplicate debt or inconsistent UI | Idempotent command handling; authoritative status refresh; mutation retries disabled |
| Funding | Incorrect recipient or stale quote | Funds sent to wrong account | Preview from authoritative API/chain data; wallet confirmation; revalidate before submission |
| Funding | RPC failure after transaction submission | Unknown settlement state | Store transaction hash before response completion; reconcile from chain events; never blindly retry a write |
| Repayment | Underpayment, overpayment, or wrong loan association | Incorrect debt balance | Contract and backend arithmetic checks; borrower/loan authorization; atomic repayment event and ledger update |
| Repayment | Replay of a signed repayment | Double charge | Contract nonce or transaction uniqueness; backend idempotency; duplicate event alerts |
| Default | Clock or job manipulation | Premature or missed default | Chain/server time policy documented; privileged job scope; bounded retry and monitoring for missed runs |
| Liquidation | Unauthorized liquidation or stale collateral price | Loss of borrower collateral | Admin scope guard; price freshness bounds; pause/emergency controls; immutable audit record |
| Closure | Event ordering or webhook forgery | Incorrect final loan status | Verify webhook signatures; deduplicate events; reconcile final state from chain before closure |
| Operations | CSP/XSS, leaked PII, or excessive diagnostics | Session compromise or privacy loss | Nonce CSP, redacted structured logs, PII masking, bounded CSP reports, access-controlled observability |
| Availability | Dependency outage or queue growth | Delayed settlement and user confusion | Timeouts, bounded queues, backpressure, status pages/alerts, read-only degraded mode |

## Security invariants

- Only the wallet owner or an explicitly authorized admin scope can mutate a loan.
- Financial balances and loan status are derived from authoritative chain and
  reconciled database state, never from client-provided totals.
- Every mutating request is either idempotent or carries a unique transaction
  identity that can be reconciled after a timeout.
- A transaction is never retried automatically after submission unless chain
  reconciliation proves that it was not accepted.
- State transitions are monotonic and audited: requested, funded, active,
  repaid/defaulted, liquidated, and closed.
- Secrets, JWTs, private keys, and full PII are excluded from logs and browser
  recovery storage.

## Rollout and response

1. Deploy documentation and diagnostics before changing enforcement behavior.
2. Monitor authorization failures, duplicate idempotency keys, unreconciled
   transaction hashes, default-job lag, liquidation failures, and CSP reports.
3. Roll back frontend diagnostics independently if report volume threatens API
   capacity; CSP enforcement remains unchanged.
4. Pause contract operations for an invariant violation, preserve evidence, and
   reconcile database state against chain events before resuming.
5. Rotate JWT/API credentials and webhook secrets when compromise is suspected.

## Residual risk

A compromised wallet remains able to authorize actions permitted to that wallet;
application controls cannot recover a private key. RPC outages can leave a
transaction in an unknown state until reconciliation completes. Oracle or
external-provider corruption requires independent freshness and sanity checks,
plus an operational pause path. These risks require monitoring and incident
runbooks in addition to code controls.
