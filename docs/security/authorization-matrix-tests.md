# Continuous Authorization Matrix Testing

> Resolves [#367](https://github.com/JhayJ22/remitlend/issues/367).
>
> This document describes the strategy for keeping the RemitLend authorization
> matrix continuously verified by automated tests.  The companion test file is
> `backend/src/__tests__/authorizationMatrix.test.ts`.

---

## 1. Motivation

The authorization matrix in [docs/SECURITY-MODEL.md](../SECURITY-MODEL.md)
documents which roles and scopes are required for each route.  Without
automated tests, the matrix can drift from the code silently — a refactor or
new route may widen access without anyone noticing.

This test suite encodes the matrix directly as assertions so that any scope
regression fails CI immediately.

---

## 2. Coverage

The test suite covers three dimensions:

| Dimension | What is tested |
|---|---|
| **Role → 401** | Unauthenticated requests are rejected with `401`. |
| **Role → 403** | Authenticated requests with the wrong role or missing scope are rejected with `403`. |
| **Role → 2xx** | Authenticated requests with the correct role pass the auth layer (downstream may return non-2xx for DB reasons; that is acceptable). |

Every route group listed in [docs/SECURITY-MODEL.md](../SECURITY-MODEL.md) is
represented by at least one test case.

---

## 3. Test File Location

```
backend/src/__tests__/authorizationMatrix.test.ts
```

The file follows the same conventions as `poolRouteScopes.test.ts` and
`indexerRouteScopes.test.ts`:

- Uses `supertest` against the live Express `app` instance.
- Mints short-lived JWTs with `jsonwebtoken` signed with
  `process.env.JWT_SECRET`.
- Sets `process.env.LENDER_WALLETS` before the `app` import so the RBAC
  middleware resolves roles correctly.
- Iterates over a typed route matrix so adding a new route requires only a
  new entry in the matrix array.

---

## 4. Running the Tests

```bash
cd backend
npm test -- --testPathPattern=authorizationMatrix
```

Or run the full backend test suite:

```bash
cd backend
npm test
```

---

## 5. Extending the Matrix

When you add a new route or change a scope requirement:

1. Update the `ROUTE_MATRIX` constant in `authorizationMatrix.test.ts`.
2. Update the table in `docs/SECURITY-MODEL.md`.
3. Run `npm test -- --testPathPattern=authorizationMatrix` to verify.

Failure to update the test file is caught by the test itself (if you change a
scope in `rbac.ts` without updating the matrix, the 403 → 2xx or 2xx → 403
assertions will flip).

---

## 6. Relationship to Other Docs

- [docs/SECURITY-MODEL.md](../SECURITY-MODEL.md) — authoritative route/scope table.
- [docs/security/privileged-action-approval-policy.md](privileged-action-approval-policy.md) — policy for admin routes.
- [docs/security/data-retention-matrix.md](data-retention-matrix.md) — which data these routes protect.
