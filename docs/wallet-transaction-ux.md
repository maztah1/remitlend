# Wallet Transaction UX — Contributor Guide

This guide describes how wallet-connected transactions work in RemitLend, the patterns contributors must follow when building or modifying any flow that submits a Stellar transaction, and the rules governing error handling, retry, and user-visible status.

---

## 1. Overview

RemitLend uses the Stellar Wallet Kit (Freighter) for wallet connectivity. The transaction lifecycle is:

1. The backend **builds** an unsigned XDR transaction envelope.
2. The frontend **shows** a preview to the user and requests wallet signing.
3. The wallet **signs** the transaction.
4. The frontend (or backend) **submits** the signed XDR to the Stellar network via the backend's `/submit` endpoint.
5. The backend polls for the transaction result and returns the final status to the UI.

Every user-visible flow — loan application, repayment, liquidity deposit, withdrawal — follows this exact pattern. Do not bypass it.

---

## 2. Transaction Preview Requirement

**Every transaction that a user signs must be preceded by a preview modal.** This is non-negotiable for user safety — Stellar transactions are irreversible once confirmed.

The preview modal (`TransactionPreviewModal`) shows:
- A human-readable description of the operation (e.g. "Deposit 100 USDC into the lending pool")
- Expected balance changes
- Estimated network fee
- A disclaimer that the transaction is irreversible
- An acknowledgement checkbox that the user must tick before confirming

Use the `useTransactionPreview` hook to integrate the preview into any new flow:

```tsx
import { useTransactionPreview } from "@/hooks/useTransactionPreview";

function DepositButton({ amount }: { amount: number }) {
  const txPreview = useTransactionPreview();

  const handleDeposit = async () => {
    // 1. Fetch the unsigned XDR from the backend
    const { xdr, fee } = await api.pool.buildDeposit({ amount });

    // 2. Show the preview and pass the confirm handler
    txPreview.show(
      {
        description: `Deposit ${amount} USDC into the lending pool`,
        balanceChanges: [{ asset: "USDC", delta: -amount }],
        fee,
      },
      async () => {
        // 3. This runs only after the user confirms
        const signed = await signWithWallet(xdr);
        await api.pool.submit({ xdr: signed });
      }
    );
  };

  return <button onClick={handleDeposit}>Deposit</button>;
}
```

See `docs/TRANSACTION_PREVIEW.md` for the full component API.

---

## 3. Signing Flow

Signing is handled through the Stellar Wallet Kit. The canonical helper is in `frontend/src/lib/`:

```ts
import { signTransaction } from "@/lib/stellar/wallet";

const signedXdr = await signTransaction(unsignedXdr, {
  networkPassphrase: NETWORK_PASSPHRASE,
});
```

### Rules for signing

- **Never pass the user's secret key** to any function. All signing must go through the wallet extension.
- `signTransaction` throws a `WalletError` if the user rejects the signing request. Catch it explicitly and show the "Transaction cancelled" state — do not treat a user rejection as an application error.
- Signing is a single attempt. Do not retry the signing step automatically.
- Do not store the signed XDR in `localStorage` or any persistent browser storage.

---

## 4. Submission and Status Polling

Submit via the backend, not directly to the Stellar horizon/soroban RPC. This ensures idempotency keys are enforced and the transaction is recorded in the backend before it is submitted on-chain.

```ts
const result = await api.pool.submit({ xdr: signedXdr });
```

The backend endpoint returns one of:

| `result.status` | Meaning |
|---|---|
| `"success"` | Transaction confirmed on-chain |
| `"pending"` | Submitted but not yet confirmed — poll again |
| `"error"` | Submission failed with a recoverable error |
| `"failed"` | Transaction rejected by the network (non-recoverable) |

### Polling

Use the `useTransactionStatus` hook for all status polling. It handles exponential back-off, timeout, and cancellation:

```tsx
const { status, error } = useTransactionStatus(transactionId, {
  onSuccess: () => refetchBalances(),
  onError: (err) => showErrorToast(err),
});
```

Do not implement manual polling with `setInterval` — always use the hook.

---

## 5. Error Handling

### Error classification

| Error type | User message | Retry? |
|---|---|---|
| User rejected signing | "Transaction cancelled." | No — user action required |
| Network fee too low | "Network is congested. Increase fee and retry." | Yes — with higher fee |
| Insufficient balance | "Insufficient balance to complete this transaction." | No — user must add funds |
| Sequence number mismatch | "Another transaction is in progress. Please wait and retry." | Yes — after current tx settles |
| RPC timeout / 5xx | "Network error. Please try again." | Yes — with back-off |
| Contract error (known code) | Use the error code mapping in `scripts/check-error-code-mappings.mjs` | Depends on error |
| Contract error (unknown code) | "Transaction failed (code: X). Contact support." | No |

### Error display rules

- Use the toast system (`docs/frontend/toasts.md`) for transient errors.
- For errors that block the entire flow (e.g., insufficient balance), show an inline error inside the modal, not just a toast.
- Never expose raw XDR, ledger sequences, or internal error objects to the user.
- Always give the user a clear next step.

### Structured error logging

Log all transaction failures to Sentry with structured context. Do not log wallet secret keys or signed XDR.

```ts
import * as Sentry from "@sentry/nextjs";

Sentry.captureException(err, {
  extra: {
    flow: "deposit",
    amount,
    txId,
    // Do NOT include xdr, signedXdr, or secretKey
  },
});
```

---

## 6. Retry and Idempotency

### When to allow retry

Show a "Try again" button only for retriable errors (see table in section 5). For non-retriable errors, replace the button with a resolution action (e.g., "Add funds", "Go to wallet").

### Idempotency

Every build request to the backend must include an idempotency key so that retrying the build step does not create duplicate transactions. The `api` client handles this automatically using the pattern in `docs/idempotency-contract.md`. Do not construct build requests manually — always use the typed API client.

### Back-off

The `useTransactionStatus` hook implements exponential back-off with a cap of 30 seconds and a total timeout of 5 minutes. If a `"pending"` transaction is still unconfirmed after 5 minutes, surface a "Transaction is taking longer than expected" warning and a support link. Do not mark it as failed automatically.

---

## 7. Authorization Checks

Transaction build endpoints are scoped by role. Before showing the transaction UI to a user, check that they have the required scope:

| Flow | Required scope |
|---|---|
| Borrow | `write:repayment` (indirectly; loan request uses borrower JWT) |
| Repay | `write:repayment` |
| Deposit liquidity | `write:pool` |
| Withdraw liquidity | `write:pool` |
| Emergency withdraw | `write:pool` |

If the user does not have the required scope, show a 403 error state — do not silently drop the request or show a loading spinner indefinitely. The auth model is in `docs/SECURITY-MODEL.md`.

> **Known gap**: lenders currently do not have `write:pool`. Pool write endpoints return 403 for lenders. This is tracked in issue #1179. Until resolved, the frontend must handle the 403 gracefully and show a descriptive message rather than a generic error.

---

## 8. Wallet Connection State

Always check wallet connection before initiating any transaction flow. Use the `useWallet` hook:

```tsx
import { useWallet } from "@/hooks/useWallet";

function TransactionWidget() {
  const { connected, publicKey, connect } = useWallet();

  if (!connected) {
    return (
      <button onClick={connect}>Connect Wallet</button>
    );
  }

  return <TransactionForm senderAddress={publicKey} />;
}
```

Do not show transaction forms to disconnected users. Do not attempt to sign without confirming `connected === true` first.

---

## 9. Testing Requirements

Every transaction flow must have:

1. **A unit test** for the build step (mocking the API call) that covers:
   - Success path
   - Insufficient balance error
   - Network error / 5xx

2. **A unit test** for the signing step covering user rejection.

3. **An E2E test** (`frontend/e2e/`) covering the happy path.

Run existing E2E tests as a reference:
```bash
cd frontend
npx playwright test e2e/borrower-loan-flow.spec.ts
npx playwright test e2e/borrower-repay-flow.spec.ts
npx playwright test e2e/lender-withdraw-flow.spec.ts
```

When adding a new flow, add a corresponding spec file following the naming convention `<role>-<action>-flow.spec.ts`.

---

## 10. Accessibility

Transaction confirmation dialogs must meet WCAG 2.1 AA:

- Modal must trap focus while open.
- Confirmation and cancel buttons must have descriptive `aria-label` attributes.
- Amount and fee values must be presented in both numeric and human-readable form.
- The acknowledgement checkbox must be keyboard-accessible.
- Do not rely solely on colour to convey transaction status (success/error).

Run the accessibility checks before opening a PR:
```bash
cd frontend
npx playwright test e2e/a11y.spec.ts
```

---

## Related Documentation

- [Transaction Preview Modal](../TRANSACTION_PREVIEW.md)
- [Security Model / Auth & Scopes](../SECURITY-MODEL.md)
- [Toast Notifications](frontend/toasts.md)
- [React Query Patterns](frontend/react-query.md)
- [Idempotency Contract](../idempotency-contract.md)
- [Error Tracking](frontend/error-tracking.md)
