# Privileged Action Approval Policy

> Resolves [#366](https://github.com/JhayJ22/remitlend/issues/366).
>
> This policy defines which operations require multi-party approval before
> execution, the approval workflow, audit requirements, and rollback procedures.
> It complements the role/scope model in
> [docs/SECURITY-MODEL.md](../SECURITY-MODEL.md).

---

## 1. Purpose

RemitLend handles real user funds, personally identifiable information, and
Soroban smart contracts that cannot be changed without an upgrade cycle.
A single compromised admin credential must not be sufficient to cause
irreversible harm.  This policy establishes a **two-admin approval gate** for
every action that is either irreversible, has broad blast-radius, or touches
production financial state.

---

## 2. Privileged Action Categories

### Category A — Requires Two-Admin Approval

These actions **must not be executed** until a second admin has explicitly
approved the request in the incident-management system (GitHub Issue, Jira, or
equivalent — see §4).

| Action | System | Irreversible? | Notes |
|---|---|---|---|
| Emergency contract pause | Soroban (`multisig_governance`) | No (can be resumed) | Halts all lending activity; high blast-radius. |
| Contract upgrade (new WASM) | Soroban | Effectively yes | See `contracts/UPGRADE_PROCESS.md`. |
| Governance proposal execution | Soroban | Yes | Multisig threshold enforced on-chain. |
| Production database schema change outside migration cycle | PostgreSQL | Potentially yes | Ad-hoc DDL in production. |
| Bulk PII deletion / erasure | PostgreSQL | Yes | Must reference specific `audit_log` entry. |
| Rotation of `JWT_SECRET` | Backend env | Partially (forces re-auth) | All live sessions invalidated. |
| Rotation of `PII_ENCRYPTION_KEY` | Backend env | No (with re-encrypt migration) | Requires re-encryption of all PII columns. |
| Rotation of `INTERNAL_API_KEY` | Backend env | No | All API-key clients must update. |
| Lender wallet list change (`LENDER_WALLETS`) | Backend env | No | Changes who can access lender routes. |
| Admin wallet list change (`ADMIN_WALLETS`) | Backend env | No | Changes who has admin role. |
| Production data export containing PII | Backend | No | Must be encrypted in transit and at rest. |
| Disable / bypass rate-limiting in production | Backend middleware | No | Risk of DoS amplification. |
| Force-resolve a loan dispute | Backend API | Yes | Modifies financial record. |
| Delete or override an audit log entry | PostgreSQL | Yes | Strictly prohibited; requires security team sign-off. |

### Category B — Single Admin, Logged

These actions may be performed by a single admin but must produce a structured
audit log entry (see §5):

| Action | System | Notes |
|---|---|---|
| Reindex contract events | Backend cron | Idempotent; can be re-run. |
| Create / delete webhook subscription (admin) | Backend API | Non-destructive to financial state. |
| Add / remove a borrower dispute record | Backend API | Audit-logged at the row level. |
| Deploy to staging | CI/CD | Staging only; no production funds at risk. |
| Read production logs | Logging infra | Read-only. |

### Category C — Self-Service (any authenticated user)

| Action | Notes |
|---|---|
| Submit remittance evidence | Borrower scope. |
| Request loan | Borrower scope. |
| Deposit / withdraw from pool | Lender scope (`write:pool`). |
| Update notification preferences | Borrower scope. |
| Account deletion request | Triggers Category A PII deletion review. |

---

## 3. Approval Workflow

```
Requestor (admin-1)                  Approver (admin-2)              System
     │                                     │                            │
     │─ 1. Create approval request ────────────────────────────────────►│
     │    (GitHub Issue / incident ticket)                              │
     │    Include: action, scope, rollback plan, justification          │
     │                                     │                            │
     │◄─────────────────────────────────── 2. Review & approve ─────────│
     │                                    (or reject with reason)       │
     │                                     │                            │
     │─ 3. Execute with audit reference ───────────────────────────────►│
     │    (include ticket ID in every command / API call)               │
     │                                     │                            │
     │◄──────────────────────────────────────── 4. Outcome logged ──────│
     │                                     │                            │
     │─ 5. Close ticket with evidence ─────────────────────────────────►│
```

### Step-by-Step

1. **Requestor creates a ticket** in the agreed approval channel with:
   - Description of the action and the affected system.
   - Justification (incident reference, user request ID, etc.).
   - Estimated blast-radius and reversibility assessment.
   - Proposed rollback procedure if the action goes wrong.
   - Target execution window (UTC timestamp range).

2. **Approver reviews** the ticket.  The approver must be a _different_ person
   from the requestor (no self-approval).  The approver confirms:
   - The justification is valid.
   - The rollback plan is actionable.
   - No safer alternative exists.
   - The execution window is appropriate.

3. **Requestor executes** the action within the approved window.  Every shell
   command or API call must include the ticket ID as a comment or `--message`
   flag where the tool supports it.

4. **System records outcome** — `audit_logs` entry created automatically (see
   §5).  For manual DB operations the requestor must INSERT the row explicitly.

5. **Requestor closes the ticket** with:
   - Evidence that the action completed successfully (log snippet, transaction
     hash, API response).
   - Confirmation that the rollback procedure was not needed _or_ description
     of any partial rollback executed.

### Timeout and Expiry

- An approval is valid for **24 hours** from the approver's sign-off.
- If the action is not executed within the window, a new approval request is
  required.
- Emergency situations (active incident, funds at risk) may compress the
  review to 15 minutes, but both admins must still produce a written record
  before or within 1 hour of execution.

---

## 4. Approval Channels

| Channel | When to Use |
|---|---|
| GitHub Issue (label `privileged-action`) | Standard approval workflow. |
| Private team Telegram / Signal group | Active incident (funds at risk, data breach). |
| Video call with screen recording | Highest-sensitivity actions (key rotation, contract upgrade). |

All channels must produce a written record that is linked from the `audit_logs`
entry.

---

## 5. Audit Requirements

Every Category A and Category B action must produce a row in `audit_logs`:

```sql
INSERT INTO audit_logs (
  action,          -- e.g. 'contract_pause', 'pii_bulk_delete'
  actor_pubkey,    -- admin's Stellar public key
  target,          -- affected resource (table name, contract ID, etc.)
  metadata,        -- JSONB: { ticket_id, approver_pubkey, justification }
  status,          -- 'success' | 'failure' | 'partial'
  created_at
) VALUES (...);
```

`audit_logs` rows are **append-only**.  Any attempt to `UPDATE` or `DELETE`
an audit log entry is itself a Category A action and requires explicit security
team authorisation (and is typically prohibited entirely).

Audit log entries must be retained for **7 years** per the
[Data Retention Matrix](data-retention-matrix.md).

---

## 6. Smart-Contract Governance

On-chain privileged actions (contract pause, upgrade, governance execution) are
additionally protected by the `multisig_governance` contract:

- The contract requires a configurable quorum of governance key signers.
- The off-chain approval workflow in §3 must be completed _before_ any
  governance transaction is submitted.
- The `multisig_governance` contract's threshold must not be lowered without a
  Category A approval cycle covering the threshold change itself.

See `contracts/multisig_governance/` and `contracts/UPGRADE_PROCESS.md` for
implementation details.

---

## 7. Failure, Retry, and Rollback

### Failure During Execution

If a privileged action fails partway through:

1. **Stop immediately.** Do not attempt to continue or work around the failure
   without a new approval cycle.
2. **Assess the partial state.** Document in the ticket what was applied and
   what was not.
3. **Execute rollback** if the partial state leaves the system in an
   inconsistent or insecure condition.
4. **Open a new approval ticket** for the corrective action, even if the fix
   is trivial.

### Rollback Procedure Requirements

Every Category A approval request must include:

- The specific rollback SQL / CLI commands or contract transactions.
- The conditions under which rollback is triggered.
- The person responsible for executing the rollback if the original requestor
  is unavailable.

### Retry

A previously approved action that was not executed (e.g., blocked by a
deployment window) must go through a new approval cycle.  Prior approval does
not carry over to a new execution attempt.

---

## 8. Threat Model Notes

| Threat | Mitigation |
|---|---|
| Single admin account compromise | Two-admin gate for all irreversible actions. |
| Social engineering of approver | Async, written approval with justification trail reduces social pressure. |
| Emergency used to bypass controls | 15-minute emergency window still requires two admins; written record within 1 hour. |
| Insider threat (both admins collude) | Audit logs are append-only and retained 7 years; independent security review periodically audits log for anomalous entries. |
| Ticket spoofing / tampering | Approval must reference the ticket ID; both admins must be listed as participants in the ticket system's audit trail. |

---

## 9. Compatibility and Rollout

- This policy does not require any schema or code changes in the current
  release.
- Teams should immediately begin using the GitHub Issue label
  `privileged-action` for all new Category A requests.
- Existing `audit_logs` entries from before this policy are grandfathered;
  new entries from this date forward must comply with §5.

---

## 10. Document Maintenance

Review triggers:

- Addition of any new admin-scope API endpoint.
- Change to `ADMIN_WALLETS`, `LENDER_WALLETS`, or any secret environment
  variable.
- Any security incident that involved a privileged action.
- Annual review.

Owner: Security team.  Last reviewed: 2026-09-24.
