# Release Acceptance Checklist

> **Issue #408** – structured release gate with evidence links.
>
> This checklist must be completed and linked in every release PR before merging
> to `main`. Copy the template below, fill in each item, and paste the completed
> checklist into the PR description.

---

## How to use this document

1. Open the release PR targeting `main`.
2. Copy the **Release Checklist Template** section below into the PR body.
3. Work through each item; paste CI run URLs, artifact links, or inline notes as evidence.
4. All items in the **Required** sections must show ✅ before the PR may be merged.
5. Attach or link this completed checklist to the GitHub release notes.

---

## Release Checklist Template

> Replace every `<!-- … -->` placeholder with a real URL or brief note.

### 0 · Release metadata

| Field | Value |
|---|---|
| Release tag / version | <!-- e.g. v1.4.2 --> |
| Target branch | `main` |
| Release PR | <!-- #NNN --> |
| Release date (UTC) | <!-- YYYY-MM-DD --> |
| Release author | <!-- @github-handle --> |
| Rollback PR / tag | <!-- link to prior working tag or rollback PR --> |

---

### 1 · CI green ✅ (Required)

All status checks on the release PR must pass before merge.

- [ ] **supply-chain-audit** passed  
  Evidence: <!-- link to CI run step -->
- [ ] **money-policy** generated artifacts are up-to-date  
  Evidence: <!-- link to CI run step -->
- [ ] **backend** lint / build / typecheck / tests passed  
  Evidence: <!-- link to CI run step -->
- [ ] **frontend** lint / typecheck / unit tests / build / performance:budget passed  
  Evidence: <!-- link to CI run step -->
- [ ] **frontend mobile performance budget** passed  
  Evidence: <!-- link to `performance:budget:mobile` CI step -->
- [ ] **e2e (chromium)** passed  
  Evidence: <!-- link to CI run step -->
- [ ] **e2e mobile-chrome** passed  
  Evidence: <!-- link to CI run step -->
- [ ] **contracts** fmt / clippy / tests / wasm size budget passed  
  Evidence: <!-- link to CI run step -->
- [ ] **migration-check** up → down → up round-trip passed  
  Evidence: <!-- link to CI run step -->
- [ ] **contract-compatibility** suite passed  
  Evidence: <!-- link to CI run step -->

---

### 2 · Deployed-contract registry ✅ (Required for contract changes)

_Skip this section if no contracts were redeployed._

- [ ] `docs/deployed-contracts.md` updated with new contract IDs, deploy date, and commit SHA  
  Evidence: <!-- link to the updated row in docs/deployed-contracts.md -->
- [ ] Backend CI secrets (`LOAN_MANAGER_CONTRACT_ID`, etc.) updated in repository settings  
  Evidence: <!-- confirmation note – do not paste secret values -->
- [ ] Frontend env var `NEXT_PUBLIC_LENDING_POOL_CONTRACT_ID` updated in staging/production  
  Evidence: <!-- confirmation note -->
- [ ] `contract-compatibility` check passed against the **new** contract IDs  
  Evidence: <!-- link to CI run for the release PR -->

---

### 3 · Database migrations ✅ (Required for migration changes)

_Skip this section if no migrations were added or changed._

- [ ] New migrations follow the naming convention `<timestamp>_<description>.js`  
  Evidence: <!-- list migration file names -->
- [ ] `migration-check` job: migrate-up → migrate-down → migrate-up round-trip passed  
  Evidence: <!-- link to CI run step -->
- [ ] Down migrations verified not to destroy data unrecoverably (reviewed by a second engineer)  
  Reviewer: <!-- @github-handle -->

---

### 4 · Security ✅ (Required)

- [ ] No secrets, PII, or private keys committed  
  Evidence: <!-- link to `Scan for plaintext PII in logs` CI step -->
- [ ] No plaintext PII columns in new migrations  
  Evidence: <!-- link to `Verify no plaintext PII columns` CI step -->
- [ ] CodeQL analysis passed (or no new HIGH/CRITICAL findings)  
  Evidence: <!-- link to CodeQL run -->
- [ ] Trivy / supply-chain scan clean (`.trivyignore` not widened without review)  
  Evidence: <!-- link to supply-chain-audit step -->
- [ ] Threat-model notes added to PR description for any new attack surface  
  Evidence: <!-- inline in PR body or link to SECURITY-MODEL.md update -->

---

### 5 · Compatibility impact ✅ (Required)

- [ ] API contract drift check passed (no breaking changes, or breaking changes are intentional and versioned)  
  Evidence: <!-- link to contract-drift workflow run -->
- [ ] `docs/api-reference.md` updated if any endpoint signatures changed  
  Evidence: <!-- link to diff or "no API changes" -->
- [ ] Existing clients / frontends are not broken by this release  
  Evidence: <!-- e2e green + manual smoke test note -->

---

### 6 · Performance ✅ (Required)

- [ ] Desktop JS bundle within budget (`npm run performance:budget`)  
  Evidence: <!-- link to CI step or before/after bytes -->
- [ ] Mobile JS bundle within budget (`npm run performance:budget:mobile`)  
  Evidence: <!-- link to CI step or before/after bytes -->
- [ ] No CLS regressions detected on landing page (`mobile-performance.spec.ts`)  
  Evidence: <!-- link to e2e mobile-chrome CI step -->
- [ ] WASM size budgets not exceeded  
  Evidence: <!-- link to `Build contracts for wasm32` CI step -->

---

### 7 · Documentation ✅ (Required)

- [ ] `CHANGELOG.md` / release notes drafted (or GitHub release body written)  
  Link: <!-- link to draft release / changelog PR -->
- [ ] Any new environment variables documented in `docs/ENVIRONMENT.md`  
  Evidence: <!-- "no new env vars" or link to updated section -->
- [ ] Runbook updated if operational procedures changed  
  Evidence: <!-- link to updated runbook or "no operational changes" -->

---

### 8 · Rollout steps

Describe the order of operations for this release. Example template:

```
1. Merge release PR → CI auto-deploys staging.
2. Smoke-test staging: <list key flows>.
3. Run 'scripts/deploy.ts' to redeploy contracts (if applicable).
4. Update docs/deployed-contracts.md with new IDs (if applicable).
5. Promote staging image to production via <CI job / manual step>.
6. Monitor Sentry / logs for 30 minutes post-deploy.
7. If rollback needed: revert to tag <prior-tag> and redeploy.
```

---

### 9 · Verification evidence summary

Paste the final CI run URL (must be green) and any notable before/after measurements:

| Metric | Before | After | CI Evidence |
|---|---|---|---|
| Desktop JS bundle (bytes) | <!-- --> | <!-- --> | <!-- --> |
| Mobile JS bundle (bytes) | <!-- --> | <!-- --> | <!-- --> |
| Largest WASM (bytes) | <!-- --> | <!-- --> | <!-- --> |
| e2e pass rate | <!-- --> | <!-- --> | <!-- --> |
| CLS (landing, mobile) | <!-- --> | <!-- --> | <!-- --> |

---

## Definitions

| Term | Meaning |
|---|---|
| **Required** | PR cannot merge until item is ✅ |
| **Evidence** | A CI run URL, artifact link, or a brief inline note confirming the check was run |
| **Rollback** | Reverting to the previous release tag plus any compensating migration `down` |

---

## References

- CI workflows: `.github/workflows/`
- Deployed contracts registry: [`docs/deployed-contracts.md`](deployed-contracts.md)
- Environment variables: [`docs/ENVIRONMENT.md`](ENVIRONMENT.md)
- Security model: [`docs/SECURITY-MODEL.md`](SECURITY-MODEL.md)
- Runbooks: [`docs/runbooks/README.md`](runbooks/README.md)
- API reference: [`docs/api-reference.md`](api-reference.md)
