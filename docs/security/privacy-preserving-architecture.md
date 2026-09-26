# Privacy-Preserving Remittance Evidence Architecture

> Resolves [#365](https://github.com/JhayJ22/remitlend/issues/365).
>
> This document describes how RemitLend proves remittance history to lenders
> and the smart-contract system without revealing the borrower's personal
> financial details beyond what is necessary.  It should be read alongside
> [docs/SECURITY-MODEL.md](../SECURITY-MODEL.md) (auth/RBAC) and
> [docs/security/data-retention-matrix.md](data-retention-matrix.md)
> (retention/deletion).

---

## 1. Problem Statement

Migrant workers using RemitLend must demonstrate a credible remittance history
to receive fair loan terms.  Naively publishing all remittance metadata
on-chain (amounts, recipients, timestamps, corridors) would:

- expose the borrower's income level and family relationships to every Stellar
  node operator and public indexer;
- create a permanent, irrevocable privacy leak since on-chain data cannot be
  deleted;
- risk discriminatory profiling based on transfer corridors or amount patterns.

The architecture below shows how RemitLend produces a **cryptographic proof of
remittance history** that is sufficient for credit scoring and on-chain
collateral, while withholding sensitive details from all parties that do not
need them.

---

## 2. Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                        BORROWER DEVICE                          │
│  • Holds raw remittance receipts (off-chain)                    │
│  • Signs Stellar transactions                                   │
│  • Selects disclosure level before submitting proof             │
└───────────────────────────┬─────────────────────────────────────┘
                            │  selective disclosure
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                  REMITLEND BACKEND (trusted)                    │
│  • Verifies raw evidence off-chain                              │
│  • Computes credit score                                        │
│  • Issues signed score attestation                              │
│  • Stores PII-stripped evidence hash in PostgreSQL              │
│  • Mints RemittanceNFT (commitment only) on Soroban             │
└───────────────────────────┬─────────────────────────────────────┘
                            │  commitment hash + score
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    STELLAR LEDGER (public)                      │
│  • RemittanceNFT: Poseidon/SHA-256 commitment only              │
│  • No amounts, corridors, or recipient identifiers on-chain     │
│  • Lending pool reads NFT existence for collateral check        │
└─────────────────────────────────────────────────────────────────┘
                            │  aggregated score
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                      LENDER (untrusted)                         │
│  • Sees credit score band and NFT existence proof               │
│  • Does NOT see transfer amounts, recipients, or corridors      │
│  • May request limited disclosure via governed reveal flow      │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. On-Chain Privacy Model: The Commitment Scheme

### 3.1 What the NFT Stores

The `remittance_nft` Soroban contract stores a **commitment** — not raw data:

```
commitment = SHA-256(amount_stroops ‖ corridor_code ‖ timestamp_unix ‖ borrower_pubkey ‖ salt)
```

- `salt` is a 32-byte random value generated per remittance by the backend and
  stored encrypted in PostgreSQL (see §4).
- The commitment is a 32-byte hash — opaque to on-chain observers.
- The `lending_pool` and `loan_manager` contracts only check that a valid NFT
  exists for a given `borrower_pubkey`; they never inspect the commitment's
  pre-image.

### 3.2 What the NFT Does NOT Store

The following fields **must never appear** in any Soroban storage key or event
topic/data:

| Field | Reason |
|---|---|
| Recipient name | Direct PII |
| Recipient phone / email | Direct PII |
| Exact transfer amount | Precise financial fingerprinting |
| Sending / receiving institution name | Correlates with specific financial relationships |
| Originating IP address | Network surveillance |
| Device fingerprint | Linkability across sessions |

### 3.3 Score Aggregation Before Publishing

The backend computes an aggregated `credit_score` from the full remittance
history (see `backend/src/services/scoreService.ts`).  Only the **score band**
(e.g., `A`, `B+`, `C`) is published on-chain as NFT metadata; never the
individual transfer details that produced it.

---

## 4. Off-Chain Evidence Handling

### 4.1 Evidence Ingestion

When a borrower submits a remittance receipt via `POST /api/remittances`:

1. The backend validates the receipt format and checks for replay (idempotency
   key — see `docs/idempotency-contract.md`).
2. PII fields (`recipient_name`, `recipient_phone`, `recipient_email`) are
   **encrypted at rest** using `piiCrypto.encryptField()` before being written
   to PostgreSQL.
3. A per-remittance `salt` is generated, encrypted, and stored alongside the
   record.
4. The commitment hash is computed and returned to the caller for inclusion in
   the NFT mint transaction.

### 4.2 Off-Chain Evidence Schema (PostgreSQL `remittances`)

```
remittances
  id              uuid        PK
  borrower_pubkey text        indexed (pseudonymous — see note)
  amount_stroops  bigint      financial record; NOT in NFT
  corridor_code   text        e.g. "PH-US"; NOT in NFT
  transfer_date   timestamptz financial record; only date precision in NFT
  commitment_hash text        the value posted on-chain
  salt_enc        text        encrypted 32-byte salt (AES-256-GCM)
  recipient_name_enc  text    encrypted PII
  recipient_phone_enc text    encrypted PII
  recipient_email_enc text    encrypted PII
  created_at      timestamptz operational
```

> **Pseudonymity note:** `borrower_pubkey` is a Stellar address.  It is
> publicly observable on-chain but is not directly linked to a real-world
> identity within RemitLend's database.  The PII columns are the only
> off-chain link, and they are encrypted.  See
> [Data Retention Matrix §3.1](data-retention-matrix.md) for deletion rules.

### 4.3 Verification Without Revelation

A lender or smart contract can verify a borrower's claim without seeing the
underlying data:

1. The backend issues a **signed score attestation** (HMAC-SHA-256 over
   `{borrower_pubkey, score_band, valid_until}` using `SCORE_ATTESTATION_SECRET`).
2. The attestation can be presented to a lender without disclosing which
   specific transfers contributed to the score.
3. The NFT commitment on-chain serves as a Merkle-root-style anchor: anyone
   can verify that a specific transfer contributed to the commitment _if the
   borrower chooses to disclose the pre-image_, but disclosure is not required
   for loan approval.

---

## 5. Selective Disclosure Flow

```
Borrower                Backend                Lender
   │                       │                      │
   │─ POST /api/remittances ──────────────────────►│ (not shown to lender)
   │◄── commitment hash ────│                      │
   │                        │                      │
   │─ sign NFT mint tx ─────►│                     │
   │                        │─ mint NFT (commitment) ──► Stellar
   │                        │                      │
   │                        │◄─ score request ─────│
   │                        │──── score band ──────►│ (A, B+, C…)
   │                        │                      │
   │  (optional: dispute)   │                      │
   │─ reveal pre-image ─────►│ (verify commitment) │
   │                        │──── verified amount ─►│ (only if borrower consents)
```

The backend acts as a **privacy gateway**:

- It holds the encrypted pre-images.
- A lender can request additional disclosure only through a governed channel
  (see [Privileged Action Approval Policy](privileged-action-approval-policy.md)).
- The borrower's consent is required before any pre-image is disclosed.

---

## 6. Threat Model

| Threat | Mitigation |
|---|---|
| On-chain privacy leak via NFT events | NFT stores commitment hash only; no PII in contract storage or event topics. |
| Lender correlates transfers via amounts | Lenders receive score band, not raw amounts. |
| Backend operator reads PII | PII encrypted at rest; decryption key (`PII_ENCRYPTION_KEY`) stored separately from application secrets. |
| Borrower submits fraudulent receipts | Backend verifies receipt signatures from supported payment providers; commitment hash binds the verified data. |
| Commitment pre-image brute-force | 32-byte random salt makes pre-image search computationally infeasible. |
| JWT token theft exposes remittance list | JWTs are scoped (`read:remittances`); borrower tokens only read their own records (row-level filtering by `borrower_pubkey`). |
| Replay of old remittance receipts | Idempotency key (transfer ID + provider) prevents duplicate commitments. |
| Admin bulk-export of PII | Requires `admin:all` API key _and_ a two-admin approval (see [Privileged Action Approval Policy](privileged-action-approval-policy.md)). |

---

## 7. Authorization Requirements

Routes that touch remittance evidence enforce the following scope matrix:

| Operation | Required Scope | Role(s) |
|---|---|---|
| Submit remittance evidence | `write:remittances` | borrower |
| Read own remittance list | `read:remittances` | borrower |
| Read any remittance (admin audit) | `admin:all` | admin |
| Trigger score recomputation | `write:remittances` | borrower |
| Request pre-image disclosure (dispute) | `admin:disputes` | admin |

> These scopes are enforced by `requireScopes` middleware; any regression in
> scope enforcement is caught by the continuous authorization matrix tests (see
> [authorization-matrix-tests.md](authorization-matrix-tests.md)).

---

## 8. Environment Variables

| Variable | Purpose | Required |
|---|---|---|
| `PII_ENCRYPTION_KEY` | 32-byte hex key for AES-256-GCM PII field encryption | Yes |
| `SCORE_ATTESTATION_SECRET` | HMAC key for signing score attestations | Yes |
| `PII_ENCRYPTION_IV_LENGTH` | IV length in bytes (default `12`) | No |

See [docs/ENVIRONMENT.md](../ENVIRONMENT.md) for full reference.

---

## 9. Compatibility and Rollout

- **No contract changes required.** The commitment scheme is already used by
  the existing `remittance_nft` contract.  This document formalises the
  architecture and constraints that must be preserved in future contract
  upgrades.
- **No migration required.** Existing `remittances` rows already use the PII
  encryption column layout (migration `1797000000000_pii-field-encryption.js`).
- **Score attestation endpoint** (`POST /api/scores/:publicKey/attestation`) is
  a future addition; the secret variable should be provisioned now.

---

## 10. Document Maintenance

Review triggers:

- Any change to the `remittance_nft` contract's storage schema.
- Any change to the `remittances` PostgreSQL table.
- Addition of a new disclosure / reveal flow.
- Annual review.

Owner: Security / Contracts team.  Last reviewed: 2026-09-24.
