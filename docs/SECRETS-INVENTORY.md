# Secrets Inventory

> Security issue #359 — secrets inventory and automated exposure scanning.
>
> This document is the single source of truth for every secret, credential, and
> sensitive configuration value used across the RemitLend stack. Keep it
> up-to-date whenever a new secret is introduced or an existing one is rotated.

---

## Threat model

An exposed secret can allow an attacker to:

| Secret class | Impact if exposed |
|---|---|
| `JWT_SECRET` | Forge JWT tokens for any user, including admin. |
| `INTERNAL_API_KEY` | Call any scoped internal API endpoint without a valid JWT. |
| `LOAN_MANAGER_ADMIN_SECRET` | Submit on-chain admin transactions (approve loans, pause contracts). |
| `SCORE_RECONCILIATION_SOURCE_SECRET` | Read-only Stellar key; can enumerate borrower scores. |
| `SENDGRID_API_KEY` | Send arbitrary email from the RemitLend domain. |
| `TWILIO_AUTH_TOKEN` / `TWILIO_ACCOUNT_SID` | Send SMS from the RemitLend number. |
| `SENTRY_AUTH_TOKEN` | Upload source maps; can deanonymise stack traces. |
| `DATABASE_URL` | Full read/write access to the PostgreSQL database (PII, loan data). |
| `REDIS_URL` | Read/write rate-limit counters, JWT revocation list, idempotency keys. |

---

## Inventory by component

### Backend (`backend/.env`)

| Variable | Classification | Rotation policy | Notes |
|---|---|---|---|
| `JWT_SECRET` | **Secret** | Rotate every 90 days or on suspected compromise | Min 32 bytes, random. Invalidates all active sessions on rotation. |
| `INTERNAL_API_KEY` | **Secret** | Rotate every 90 days or on staff offboarding | Comma-separated list of scoped keys; see `docs/SECURITY-MODEL.md`. |
| `LOAN_MANAGER_ADMIN_SECRET` | **Secret — high risk** | Rotate on any suspected compromise | Stellar secret key (`S…`). Controls on-chain admin operations. Store in HSM/vault in production. |
| `SCORE_RECONCILIATION_SOURCE_SECRET` | **Secret** | Rotate every 180 days | Read-only Stellar key for score reads. |
| `DATABASE_URL` | **Secret** | Managed by infrastructure team | Contains username and password for PostgreSQL. |
| `REDIS_URL` | **Secret** | Managed by infrastructure team | May contain auth token depending on Redis ACL config. |
| `SENDGRID_API_KEY` | **Secret** | Rotate annually or on suspected compromise | Restricted to sending only; never grant template/domain management. |
| `TWILIO_ACCOUNT_SID` | **Semi-public** | N/A | Not a secret by itself but combined with `TWILIO_AUTH_TOKEN` grants full API access. |
| `TWILIO_AUTH_TOKEN` | **Secret** | Rotate annually or on suspected compromise | |
| `SENTRY_DSN` | **Non-secret** | N/A | Public ingest URL; safe to expose. |

### Frontend (`frontend/.env.local`, CI env)

| Variable | Classification | Notes |
|---|---|---|
| `SENTRY_AUTH_TOKEN` | **Secret — build-time only** | Used only during `next build` for source-map upload. Never exposed to the browser. Set in CI only; never commit. |
| `SENTRY_ORG` / `SENTRY_PROJECT` | **Non-secret** | Organisation/project slugs; not sensitive. |
| `NEXT_PUBLIC_*` | **Non-secret** | All `NEXT_PUBLIC_` vars are inlined into the browser bundle. Never put secrets here. |

### CI / GitHub Actions

| Secret name | Where set | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | Auto-injected | Gitleaks and PR operations. |
| `SENTRY_AUTH_TOKEN` | GitHub repo secrets | Source-map upload during `next build`. |

---

## Automated exposure scanning (CI)

The `secrets-scan` job in `.github/workflows/ci.yml` runs on every push and PR.
It uses two layers:

### Layer 1 — gitleaks (git-history scan)

[gitleaks](https://github.com/gitleaks/gitleaks) scans the full git history for
patterns matching known secret formats (AWS keys, GitHub tokens, private keys,
generic high-entropy strings, etc.).

Configuration: uses the default ruleset. Add project-specific allow-list entries
to `.gitleaks.toml` if a detected pattern is a documented false-positive.

### Layer 2 — grep heuristics (zero-install)

A shell-based scan checks for:

- Developer placeholder values (`your-super-secret-jwt-key`, `change-me`, etc.)
- AWS access key patterns (`AKIA[0-9A-Z]{16}`)
- PEM private key headers
- OpenAI API key prefixes (`sk-…`)

`.env.example` files are **excluded** from the grep scan because they are
permitted to contain documented placeholder values.

### Responding to a scan failure

1. **True positive** (real secret committed):
   1. Immediately rotate the exposed credential.
   2. Remove the secret from history using `git filter-repo` or open a private
      security advisory if the repo is public.
   3. Force-push the cleaned branch (requires admin bypass).
   4. Notify the security team via the process in [SECURITY.md](../SECURITY.md).

2. **False positive** (a test fixture, example value, or known safe pattern):
   1. Add an inline `gitleaks:allow` comment on the same line **or** add an
      allow-list entry in `.gitleaks.toml`.
   2. Document the reason in the PR description.

---

## Secret management practices

### Storage

| Environment | Recommended store |
|---|---|
| Local development | `backend/.env` (gitignored) |
| Staging | GitHub Actions environment secrets |
| Production | AWS Secrets Manager / HashiCorp Vault; injected at runtime |

### Never do

- Commit a `.env` file (enforced by `.gitignore` and gitleaks).
- Put secrets in `NEXT_PUBLIC_` env vars (they end up in the browser bundle).
- Log secrets (enforced by the PII scan in CI).
- Share secrets over Slack / email.
- Use the same secret value across staging and production.

### Rotation checklist

When rotating a secret:

- [ ] Generate a new high-entropy value (≥ 256 bits for symmetric keys).
- [ ] Update the value in all relevant secret stores (staging + production).
- [ ] Deploy the new value before invalidating the old one to avoid downtime.
- [ ] Revoke / delete the old credential from the issuing service.
- [ ] Update the "last rotated" date in this document.
- [ ] For `JWT_SECRET`: note that all active user sessions will be invalidated.

---

## Last-rotated log

| Secret | Last rotated | Rotated by |
|---|---|---|
| `JWT_SECRET` | — | — |
| `INTERNAL_API_KEY` | — | — |
| `LOAN_MANAGER_ADMIN_SECRET` | — | — |
| `SENDGRID_API_KEY` | — | — |
| `TWILIO_AUTH_TOKEN` | — | — |
| `SENTRY_AUTH_TOKEN` | — | — |

> Update this table whenever a rotation is performed.

---

## See also

- [SECURITY.md](../SECURITY.md) — vulnerability disclosure policy
- [docs/SECURITY-MODEL.md](SECURITY-MODEL.md) — authentication and authorisation model
- [docs/ENVIRONMENT.md](ENVIRONMENT.md) — full environment variable reference
- [docs/wiki/security-scanning.md](wiki/security-scanning.md) — Trivy container scanning
- [backend/docs/INTERNAL_REQUEST_SIGNING.md](../backend/docs/INTERNAL_REQUEST_SIGNING.md) — HMAC signing for internal routes
