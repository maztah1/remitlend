# Frontend

This package contains the web client for the platform. It renders account,
payment, and settlement surfaces and talks to the backend over the documented
HTTP API.

## Financial status taxonomy

User-visible financial state is derived from authoritative backend/chain status
strings. The frontend never invents status values and never renames the strings
returned by the API or persisted in existing records.

`src/financialStatus.ts` is the single source of truth for this mapping. It
exposes:

- `FinancialStatus` — the canonical union of UI statuses:
  `pending`, `processing`, `succeeded`, `failed`, `cancelled`, `refunded`,
  `disputed`, `unknown`.
- `FINANCIAL_STATUS_LABELS` — display labels for each status.
- `FINANCIAL_STATUS_TONES` — semantic tone (`neutral`, `info`, `success`,
  `warning`, `danger`) used for styling.
- `toFinancialStatus(value)` — maps an authoritative backend/chain status
  string into the taxonomy.
- `getFinancialStatusLabel(value)` / `getFinancialStatusTone(value)` —
  convenience accessors for rendering.

### Compatibility

- Backend and chain status strings are treated as the authoritative source and
  are **not** renamed or rewritten by the frontend.
- Mapping is case-insensitive and trims surrounding whitespace, so existing
  persisted values keep rendering correctly.
- Any unrecognized, missing, `null`, or empty value resolves to the explicit
  `unknown` status instead of throwing. This keeps stale or partially migrated
  data renderable and surfaces the gap for observability rather than crashing
  the UI.

### Bounded behavior

`toFinancialStatus` is a pure, synchronous lookup over a fixed table. It makes
no network calls, performs no retries, and has no unbounded loops, so it is safe
to call during render for every row.

### Tests

`src/financialStatus.test.ts` covers the success path, boundary values
(whitespace, casing, empty string), unknown/stale data, and the
dependency-failure path where the authoritative status is missing entirely.
