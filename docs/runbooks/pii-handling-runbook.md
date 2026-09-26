# PII Handling and Data Subject Request Runbook

This runbook covers how RemitLend handles personally identifiable information (PII), how to fulfil data subject requests (access, correction, deletion), and how to respond to a PII breach.

---

## 1. PII Inventory

RemitLend stores and processes the following PII fields. This table is authoritative — any code change that adds a new PII field must update it.

| Field | Storage location | At-rest protection | In-transit protection | Frontend display |
|---|---|---|---|---|
| Email | `user_profiles.email_encrypted` | AES-256-GCM via `piiCrypto.ts` | HTTPS / TLS | Masked (`u***@example.com`) |
| Phone | `user_profiles.phone_encrypted` | AES-256-GCM via `piiCrypto.ts` | HTTPS / TLS | Masked (`+1***1234`) |
| Full name | `user_profiles.name_encrypted` | AES-256-GCM via `piiCrypto.ts` | HTTPS / TLS | Masked (`J*** D***`) |
| Stellar address | Various tables | None (public by design) | HTTPS / TLS | Masked (`GABC…XYZ`) |
| Remittance recipient details | `remittances.recipient_*` | AES-256-GCM via `piiCrypto.ts` | HTTPS / TLS | Masked at display layer |
| Audit log entries | `audit_logs` | None (operator-level access) | HTTPS / TLS | Not displayed to users |

Fields marked as encrypted at rest are encrypted using the `encryptField()` function in `backend/src/services/piiCrypto.ts`. The encryption key is a Data Encryption Key (DEK) wrapped by a Key Encryption Key (KEK) stored in KMS, configured via `PII_KEK_ID`, `PII_KMS_ENDPOINT`, and `PII_KEK_REGION` environment variables.

Stellar addresses are public on-chain and are not encrypted at rest, but are masked in the frontend using `maskAddress()` from `frontend/src/app/utils/piiMask.ts`.

See `docs/SECURITY-MODEL.md` section "PII field inventory" for the code-level mapping between fields, masking functions, and encryption functions.

---

## 2. Encryption Key Management

### Key hierarchy

```
KMS (external)
  └── KEK (Key Encryption Key) — lives only in KMS
        └── DEK (Data Encryption Key) — wrapped by KEK, stored with ciphertext
```

The DEK is re-wrapped by the KEK each time a field is encrypted. The plaintext DEK is never persisted.

### Key rotation

1. Generate a new KEK version in KMS.
2. Set `PII_KEK_ID` to the new key ARN/ID in the backend environment.
3. Re-encrypt all encrypted fields by running the re-encryption migration:
   ```bash
   cd backend
   PII_KEK_ID=<new-key-id> npx ts-node src/scripts/rotate-pii-keys.ts
   ```
   This script reads each encrypted field, decrypts with the old KEK version, and re-encrypts with the new version.
4. Verify a sample of records by calling `decryptField()` on them after the rotation.
5. Revoke the old KEK version in KMS only after confirming all records have been rotated.

> Do not revoke the old KEK version before step 4 — if the rotation script fails partway through, you need the old key to decrypt un-rotated records.

---

## 3. Data Access and Logging

All reads of unmasked PII fields (i.e., calls to `decryptField()`) must be accompanied by an audit log entry. The audit logging middleware (`backend/src/middleware/`) writes to the `audit_logs` table automatically for all API routes. If you add a background job or script that reads decrypted PII, add a manual audit log entry:

```ts
await db.query(
  `INSERT INTO audit_logs (action, actor, resource_type, resource_id, metadata, status)
   VALUES ($1, $2, $3, $4, $5, $6)`,
  ["pii_read", "system:key-rotation-script", "user_profile", userId, {}, "success"]
);
```

Access to production PII is restricted to:
- Backend service account (via internal API key or service role)
- On-call engineers responding to an active incident — access must be logged and justified in the incident report

---

## 4. Data Subject Access Request (DSAR)

A data subject access request is a user's right to receive a copy of all personal data held about them.

### 4.1 Receiving a request

DSARs may come via:
- In-app "Download my data" feature (not yet implemented — see issue #322)
- Email to the project maintainers
- GitHub issue (maintainers must move PII out of the public issue immediately)

Log the request immediately in the incident tracker with:
- Date received
- Requested by (Stellar public key or email, whichever was provided)
- Deadline (30 days from receipt under most jurisdictions)

### 4.2 Collecting the data

Run the following queries as a backend operator (read-only access is sufficient):

```sql
-- 1. User profile
SELECT
  id,
  public_key,
  pgp_sym_decrypt(name_encrypted::bytea, current_setting('app.pii_key')) AS name,
  pgp_sym_decrypt(email_encrypted::bytea, current_setting('app.pii_key')) AS email,
  pgp_sym_decrypt(phone_encrypted::bytea, current_setting('app.pii_key')) AS phone,
  created_at
FROM user_profiles
WHERE public_key = '<USER_PUBLIC_KEY>';

-- 2. Loan history
SELECT loan_id, status, amount, created_at, updated_at
FROM loan_events
WHERE borrower = '<USER_PUBLIC_KEY>'
ORDER BY created_at;

-- 3. Remittances
SELECT id, amount, currency, created_at
FROM remittances
WHERE sender_public_key = '<USER_PUBLIC_KEY>'
ORDER BY created_at;

-- 4. Notifications
SELECT id, type, message, created_at, read_at
FROM notifications
WHERE user_public_key = '<USER_PUBLIC_KEY>'
ORDER BY created_at;

-- 5. Credit score history
SELECT score, updated_at
FROM scores
WHERE public_key = '<USER_PUBLIC_KEY>'
ORDER BY updated_at;
```

> Note: Until the `pgp_sym_decrypt` helper is available in your environment, use the `decryptField()` service in the backend and access data through a purpose-built admin API endpoint, not raw SQL on production.

### 4.3 Delivering the data

Export the results to JSON and send them to the requester via a secure channel (encrypted email or a time-limited signed download link). Do not send PII via unencrypted email, Slack, or public GitHub issues.

Remove the exported file from the server after delivery.

Audit log the delivery:

```ts
await db.query(
  `INSERT INTO audit_logs (action, actor, resource_type, resource_id, metadata, status)
   VALUES ($1, $2, $3, $4, $5, $6)`,
  [
    "dsar_delivered",
    "operator:<your-id>",
    "user_profile",
    userId,
    { method: "secure-download-link", deadline: "2026-10-24" },
    "success",
  ]
);
```

---

## 5. Data Subject Deletion Request (Right to Erasure)

A deletion request requires removing or anonymising all PII for the user. Stellar on-chain data (addresses, transaction hashes) cannot be deleted — inform the requester of this before processing.

### 5.1 Pre-deletion checks

Before deleting:
- Confirm the user has no open (active) loans. Deleting a user with an active loan would leave the loan record in an inconsistent state. If an open loan exists, the deletion must be deferred until the loan is closed.
- Check for any pending regulatory hold on the account (fraud investigation, legal hold).

### 5.2 Anonymisation procedure

RemitLend's deletion approach is anonymisation-in-place rather than hard deletion. This preserves referential integrity in loan and audit records while removing personal identifiers.

```sql
-- Run inside a transaction
BEGIN;

-- 1. Overwrite encrypted PII fields with a placeholder
UPDATE user_profiles
SET
  name_encrypted  = pgp_sym_encrypt('DELETED', current_setting('app.pii_key')),
  email_encrypted = pgp_sym_encrypt('DELETED', current_setting('app.pii_key')),
  phone_encrypted = pgp_sym_encrypt('DELETED', current_setting('app.pii_key')),
  deleted_at = NOW()
WHERE public_key = '<USER_PUBLIC_KEY>'
  AND deleted_at IS NULL;

-- 2. Anonymise remittance recipient details
UPDATE remittances
SET
  recipient_name  = 'DELETED',
  recipient_email = 'DELETED',
  recipient_phone = 'DELETED'
WHERE sender_public_key = '<USER_PUBLIC_KEY>';

-- 3. Suppress notifications (do not delete — needed for audit trail)
UPDATE notifications
SET message = 'DELETED'
WHERE user_public_key = '<USER_PUBLIC_KEY>';

COMMIT;
```

> Until the `pgp_sym_encrypt` helper is available in your environment, use the `encryptField()` service function to encrypt the placeholder string, and update via the backend API.

### 5.3 Post-deletion verification

```sql
-- Confirm no plaintext PII is accessible
SELECT name_encrypted, email_encrypted, phone_encrypted
FROM user_profiles
WHERE public_key = '<USER_PUBLIC_KEY>';
-- All fields should decrypt to 'DELETED'

-- Confirm loan records are intact (public keys are non-PII)
SELECT COUNT(*) FROM loan_events WHERE borrower = '<USER_PUBLIC_KEY>';
```

Audit log the deletion and close the request in the incident tracker.

---

## 6. PII Breach Response

### 6.1 Detection

A PII breach may be detected via:
- Security scanner alerts (`docs/wiki/security-scanning.md`)
- Anomalous `pii_read` entries in `audit_logs`
- Direct report from a contributor or external researcher

### 6.2 Immediate steps (first 1 hour)

1. **Identify the scope**: which users' data may have been accessed, and which fields.
2. **Preserve evidence**: snapshot the `audit_logs` table and relevant application logs before any remediation that might overwrite them.
3. **Contain the breach**:
   - If a compromised API key is involved, rotate it immediately (`INTERNAL_API_KEY`).
   - If a compromised KEK is involved, revoke it and re-encrypt all PII with a new key (section 2 key rotation).
   - If a compromised service account is involved, revoke it and audit all recent actions.
4. **Notify maintainers** via the contributor Telegram group or security contact in `SECURITY.md`. Do not post details publicly.

### 6.3 Assessment and notification

Within 72 hours, assess:
- How many users were affected.
- What data was exposed (fields, not values).
- Whether the exposure was internal (operator access) or external (unauthorised third party).
- Whether on-chain data (Stellar addresses, transaction hashes) was involved — this cannot be retracted.

Notify affected users promptly if there is a risk of harm. See `SECURITY.md` for the project's responsible-disclosure policy.

### 6.4 Post-incident review

Within 7 days, produce a written post-incident review covering:
- Timeline of events
- Root cause
- Data accessed and affected user count
- Remediation steps taken
- Preventive measures to avoid recurrence

---

## 7. Contributor Rules for PII

All contributors must follow these rules when working with code that touches PII:

1. **Never log PII** in plaintext. Backend logs must not contain email, phone, name, or raw Stellar addresses in contexts where they could identify a person.
2. **Never include PII in error messages** returned to the client.
3. **Never store PII in environment variables** or configuration files — these are often logged in CI.
4. **Always use `encryptField()`** before writing a new PII field to the database.
5. **Always use `maskValue()`** before returning a PII field to the frontend.
6. **Always add an audit log entry** for any new endpoint or script that decrypts PII (see section 3).
7. **Update this document and the PII inventory table** (section 1) when adding any new PII field.
8. **Write a test** that verifies the field is masked in API responses and encrypted in the database.

---

## Related Documentation

- [Security Model](../SECURITY-MODEL.md)
- [Security Policy](../../SECURITY.md)
- [Environment Variables Reference](../ENVIRONMENT.md)
- [Database Schema](../DATABASE.md)
- [Audit Logs (Database)](../DATABASE.md#audit_logs)
