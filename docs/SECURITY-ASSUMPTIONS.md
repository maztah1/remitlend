# Security Assumptions and Limitations Register

This register is the explicit list of what RemitLend's security posture **relies
on** (assumptions) and what it deliberately **does not** protect against
(limitations). Anything that is neither an enforced control nor listed here is a
gap by definition — if you find one, open an issue and add a row.

- **Audience:** contributors, reviewers, auditors, and operators.
- **Owner:** the maintainers of the affected component (see
  [CONTRIBUTING.md](../CONTRIBUTING.md)); the reviewing maintainer of a change
  that adds a row becomes its owner if no component owner is defined.
- **Review cadence:** each row is reviewed at least every **90 days** and on
  every change that touches its boundary; `Review by` carries the next due date.
- **Enforcement:**
  `backend/src/__tests__/securityRegisterDocs.test.ts` validates the structure of
  every row (unique ids, allowed status, named owner, resolvable verification
  reference), so this file cannot rot into prose.

Related documents: [SECURITY.md](../SECURITY.md) (disclosure policy),
[docs/SECURITY-MODEL.md](SECURITY-MODEL.md) (authn/authz model),
[domain-state-machines.md](domain-state-machines.md) (state and failure paths),
[API_CONTRACT_DRIFT_PREVENTION.md](API_CONTRACT_DRIFT_PREVENTION.md).

---

## Threat model in one page

| Asset | Primary threat | Enforced control (evidence) |
| --- | --- | --- |
| Borrower funds / pool liquidity | Unauthorized state change on contracts | `require_auth()` on every mutating contract entry point (`contracts/loan_manager/src/lib.rs`) |
| Wallet identity | Impersonation via forged signatures | Challenge–signature–JWT with Ed25519 verification (`backend/src/services/authService.ts`) |
| API surface | Unauthenticated or over-scoped access | `requireApiKey` scope guards + JWT role scopes (`backend/src/middleware/auth.ts`, `docs/SECURITY-MODEL.md`) |
| PII (recipient email/phone/name) | Disclosure via logs, API, or DB dumps | Field-level encryption (`backend/src/services/piiCrypto.ts`), log redaction (`LOG_REDACTION=strict`), plaintext-PII CI scan |
| Chain state | Divergence between API and chain | Reconciliation jobs + checkpoint `suspect` handling (`docs/domain-state-machines.md`) |
| Outbound webhooks | Forged or replayed deliveries | HMAC signatures + timestamp (`docs/wiki/webhook-signatures.md`) |
| Dependencies / build | Supply-chain compromise | Blocklist scan + CodeQL + Trivy (`.github/workflows/ci.yml`, `codeql.yml`) |

Trust boundaries: browser wallet → API (HTTPS), API → Stellar RPC (HTTPS),
API → Postgres/Redis (private network), API → KMS-style encryption endpoint
(`PII_KMS_ENDPOINT`), API → subscriber webhook URLs (attacker-controlled
destination, treated as untrusted).

---

## Assumptions

| ID | Assumption | Boundary | Why it matters | Verification | Owner | Status | Review by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A-1 | Soroban contract state is the authoritative record of loans and collateral. | chain | Every reconciliation pulls projections towards the chain; API/DB cannot be trusted over it. | `docs/domain-state-machines.md`, `backend/src/services/crossContractReconciler.ts` | maintainers | validated | 2026-12-31 |
| A-2 | A wallet's Stellar keypair is controlled by the account owner and signatures are not delegated. | wallet | Loans, repayments, and score changes are only as strong as key custody. | `backend/src/services/authService.ts` | maintainers | validated | 2026-12-31 |
| A-3 | `JWT_SECRET`, `INTERNAL_API_KEY`, and `LOAN_MANAGER_ADMIN_SECRET` are injected as secrets, rotated on compromise, and never committed. | deploy | Token forgery and admin-scope escalation are trivial if leaked. | `docs/ENVIRONMENT.md`, `.github/workflows/ci.yml` (env injection) | operators | monitored | 2026-12-31 |
| A-4 | Postgres and Redis are only reachable from the application network, with credentials from the environment. | infra | The API relies on network isolation, not application-level DB authz, for tenant separation. | `docker-compose.production.yml`, `backend/src/db/connection.ts` | operators | accepted | 2026-12-31 |
| A-5 | The Stellar RPC endpoint is honest about ledger contents and its network passphrase matches the deployed contracts. | chain | A dishonest RPC can hide or delay confirmations; the API reports what it observes and never fabricates success. | `backend/src/config/stellar.ts`, `docs/deployed-contracts.md` | maintainers | monitored | 2026-12-31 |
| A-6 | Webhook subscribers verify HMAC signatures and treat payloads as untrusted input. | integration | Delivery integrity is signed, but a subscriber that ignores the signature is exposed to spoofing. | `docs/wiki/webhook-signatures.md` | subscribers | accepted | 2026-12-31 |
| A-7 | The PII encryption endpoint (`PII_KMS_ENDPOINT`) performs real key management and is not reachable by untrusted parties. | integration | Recipient PII fields are only as protected as the key material behind that endpoint. | `backend/src/services/piiCrypto.ts`, `backend/docs/INTERNAL_REQUEST_SIGNING.md` | operators | accepted | 2026-12-31 |
| A-8 | Trace correlation headers (`traceparent`, `x-request-id`, `tracestate`) carry no secrets and may be logged. | observability | Trace ids are exposed to clients by design; anything sensitive must never be placed in them. | `backend/src/middleware/traceContext.ts`, `backend/src/__tests__/traceContext.test.ts` | maintainers | validated | 2026-12-31 |

---

## Limitations (accepted risks)

Each limitation is a conscious decision with a compensating control. `Status` is
`accepted` (no fix planned), `mitigated` (control reduces impact), or `open`
(fix wanted — link the tracking issue).

| ID | Limitation | Impact if exercised | Compensating control | Verification | Owner | Status | Review by |
| --- | --- | --- | --- | --- | --- | --- | --- |
| L-1 | The API is a trusted intermediary: it observes chain state through one RPC provider and can be stale between polls. | A user may briefly see a status older than the ledger. | Bounded poll interval, direct chain confirmation on submit, `NOT_FOUND` never reported as success, reconciliation jobs. | `docs/domain-state-machines.md`, `backend/src/services/scoreReconciliationService.ts` | maintainers | mitigated | 2026-12-31 |
| L-2 | In-memory/Redis rate limiting is best-effort under partition; a distributed attacker can spread load across instances. | Abuse mitigation degrades rather than fails closed during a Redis outage. | Global limiter + per-route limiters + `Retry-After` headers; Redis outage is alerted. | `backend/src/middleware/rateLimiter.ts`, `docs/rate-limiting.md` | operators | accepted | 2026-12-31 |
| L-3 | Webhook delivery is at-least-once: subscribers may receive duplicates. | Duplicate notifications unless the subscriber deduplicates. | `event_id` in every payload for idempotent handling; retry metadata exposed. | `docs/webhooks.md`, `backend/src/services/webhookService.ts` | subscribers | accepted | 2026-12-31 |
| L-4 | PII redaction depends on `LOG_REDACTION=strict` being set in the environment. | With redaction disabled, PII could reach logs. | CI scan for plaintext PII patterns; redaction list covers recipient/identity fields. | `.github/workflows/ci.yml` (PII scan), `backend/src/utils/logger.ts` | operators | mitigated | 2026-12-31 |
| L-5 | Admin and API-key actions are powerful and not multi-signature enforced by the API. | A leaked admin key can perform privileged operations. | Scoped API keys, audit logging of every privileged action, on-chain admin authority still required for settlement. | `backend/src/middleware/auth.ts`, `backend/src/middleware/auditLog.ts` | maintainers | accepted | 2026-12-31 |
| L-6 | Clients treat indexed (projected) state as authoritative for rendering. | UI can lag the chain by up to one poll interval. | Direct confirmation status on submit; UI refreshes on SSE events; reconcilers correct drift. | `frontend/src/app/hooks/useApi.ts`, `docs/domain-state-machines.md` | maintainers | mitigated | 2026-12-31 |
| L-7 | Trace data is sampled per `TRACE_CONTEXT_SAMPLE_RATE` and is not exported to an external backend. | Very low-volume flows may lack full trace coverage. | Sampling defaults to 1; correlation ids remain present on all logs regardless of sampling. | `backend/src/utils/traceContext.ts` | maintainers | accepted | 2026-12-31 |
| L-8 | Smart contracts and dependencies are not audited by a third party. | Undiscovered contract-level defects remain possible. | Extensive unit/invariant/fuzz testing in CI; pause switch for incident response. | `.github/workflows/ci.yml`, `.github/workflows/fuzz-remittance-nft.yml` | maintainers | open | 2026-12-31 |

---

## Explicit non-goals

1. **Custody.** RemitLend never holds user secret keys; key management for
   end-user wallets is out of scope.
2. **Subscriber-side integrity.** We sign webhook payloads; we do not verify a
   subscriber's own systems.
3. **Third-party infrastructure.** Hosting provider, DNS, and e-mail/SMS
   providers are out of scope for this repository's controls.
4. **Anonymous use.** Every state-changing request must be attributable to a
   wallet or an API key.

---

## Changing this register

A pull request that adds a control, changes a boundary, or discovers a new gap
must, in the same PR:

1. add or update the relevant row (new rows take the next free `A-n` / `L-n`),
2. link the code or workflow that implements or verifies it, and
3. keep the structure valid so `backend/src/__tests__/securityRegisterDocs.test.ts`
   passes (`npm test -- securityRegisterDocs` in `backend`).

