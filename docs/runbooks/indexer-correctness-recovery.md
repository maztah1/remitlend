# Indexer Correctness and Recovery Guide

This guide covers how to verify that the RemitLend event indexer is processing on-chain Soroban events correctly, and how to recover from the common failure modes: lag, data gaps, quarantined events, RPC outages, and corrupted state.

For a quick-reference recovery checklist see section 9. For escalation contacts see section 10.

---

## 1. How the Indexer Works

The `EventIndexer` service (`backend/src/services/eventIndexer.ts`) polls the Stellar RPC for contract events at a configurable interval (`INDEXER_POLL_INTERVAL_MS`, default 30 seconds). For each poll cycle it:

1. Reads `last_indexed_ledger` from the `indexer_state` table.
2. Calls `getEvents(startLedger = last_indexed_ledger + 1, contractIds = [...])` on the RPC.
3. Decodes each event's XDR topics and value.
4. Upserts decoded events into `contract_events` using `ON CONFLICT (event_id) DO NOTHING`.
5. Updates credit scores and loan state as needed, wrapped in a single database transaction.
6. Advances `last_indexed_ledger` to the highest ledger in the batch.

Events that fail decoding or validation are written to the quarantine table instead of `contract_events`. This prevents a single bad event from blocking all subsequent processing.

See `docs/wiki/indexer-sync-flow.md` for the full sequence diagram.

---

## 2. Correctness Invariants

The following conditions must hold at all times. Use these to validate a running indexer or to diagnose a suspected data integrity issue.

| Invariant | How to check |
|---|---|
| No ledger gaps in `contract_events` | Query for missing ledger sequences (see 2.1) |
| `indexer_state.last_indexed_ledger` ≤ current Stellar ledger | Compare via RPC |
| Loan state in DB matches on-chain state | Compare `loan_events` aggregate with contract storage |
| Credit scores consistent with repayment history | Sum score changes in `loan_events`, compare to `scores` table |
| No duplicate `event_id` in `contract_events` | Unique constraint enforced by migration, verify below |

### 2.1 Check for ledger gaps

```sql
SELECT
  ledger + 1 AS missing_from,
  next_ledger - 1 AS missing_to
FROM (
  SELECT
    ledger,
    LEAD(ledger) OVER (ORDER BY ledger) AS next_ledger
  FROM (
    SELECT DISTINCT ledger FROM contract_events ORDER BY ledger
  ) sub
) gaps
WHERE next_ledger - ledger > 1;
```

Empty result means no gaps. Non-empty rows indicate ranges that were never indexed — use `reindex-ledger-range` (section 5) to backfill them.

### 2.2 Check current indexer lag

```bash
# Get last indexed ledger
curl -s http://localhost:3001/api/indexer/status | jq '.last_indexed_ledger'

# Get current Stellar ledger (testnet)
curl -s -X POST https://soroban-testnet.stellar.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' | jq '.result.sequence'
```

The gap should be < `INDEXER_POLL_INTERVAL_MS × 2 / 5000` ledgers (one Stellar ledger ≈ 5 s). A gap > 100 ledgers warrants investigation.

### 2.3 Check for duplicate event_ids

```sql
SELECT event_id, COUNT(*) AS cnt
FROM contract_events
GROUP BY event_id
HAVING COUNT(*) > 1;
```

Any rows here indicate a constraint violation that must be investigated immediately. The unique constraint is enforced by migration `1788000000018_unified-contract-events.js`. If duplicates exist, a migration may not have run — check `npm run migrate:status`.

---

## 3. Detecting Indexer Failure

### Via the health endpoint

```bash
curl http://localhost:3001/api/indexer/status
```

Key fields:

| Field | Normal value | Concern |
|---|---|---|
| `status` | `"running"` | `"paused"` or `"error"` needs action |
| `rpc_status` | `"connected"` | `"unreachable"` → RPC outage (section 7) |
| `last_indexed_ledger` | Advancing each poll | Stuck → indexer has crashed |
| `quarantine_count` | 0 or low | Rising → decoding bug (section 6) |

### Via database query

```sql
SELECT
  last_indexed_ledger,
  last_indexed_at,
  NOW() - last_indexed_at AS age
FROM indexer_state;
```

`age` > 5 minutes with status `running` indicates the indexer process is alive but not writing — check backend logs.

### Via backend logs

```bash
docker compose logs --tail=200 backend | grep -i indexer
```

Common error patterns:

| Log pattern | Likely cause |
|---|---|
| `ERR_HTTP_REQUEST` / timeout | RPC connectivity issue |
| `XDR decode failed` | Contract event schema changed |
| `unique constraint violation` | Migration not applied |
| `transaction rolled back` | Database write error |

---

## 4. Pausing and Resuming the Indexer

Pause the indexer when you need to investigate without new writes interfering, or before running a `reindex-ledger-range` operation.

### Pause

```bash
curl -X POST http://localhost:3001/api/admin/indexer/pause \
  -H "x-api-key: ${INTERNAL_API_KEY}"
```

The indexer finishes its current poll cycle and then stops. In-flight events are not lost — `last_indexed_ledger` is only advanced after a successful write.

### Verify paused

```bash
curl http://localhost:3001/api/indexer/status | jq '.status'
# Expected: "paused"
```

### Resume

```bash
curl -X POST http://localhost:3001/api/admin/indexer/resume \
  -H "x-api-key: ${INTERNAL_API_KEY}"
```

The indexer resumes from `last_indexed_ledger`. Events in the gap are caught up automatically in subsequent poll cycles.

---

## 5. Reindexing a Ledger Range

Use this when events are missing or corrupted for a known range. Reindexing re-fetches and upserts events; it does not delete existing correct events.

```bash
curl -X POST http://localhost:3001/api/admin/indexer/reindex \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${INTERNAL_API_KEY}" \
  -d '{
    "startLedger": 123456,
    "endLedger": 123500,
    "contractIds": ["CA...", "CB..."]
  }'
```

**When to use:**
- Ledger gap query (section 2.1) returns rows.
- Events were mis-decoded after a schema change.
- RPC returned incomplete results during a previous poll.

**What it does:**
1. Resets `last_indexed_ledger` for the affected contracts to `startLedger - 1`.
2. Re-fetches and upserts events in the range.
3. Resumes normal polling from `endLedger + 1`.

After reindexing, re-run the gap query to confirm the range is filled.

---

## 6. Quarantined Events

Events that fail decoding or contract-level validation are moved to the quarantine table rather than dropped. This prevents a single bad event from blocking all subsequent processing.

### View quarantined events

```bash
curl http://localhost:3001/api/admin/indexer/quarantine \
  -H "x-api-key: ${INTERNAL_API_KEY}"
```

Each record includes `event_id`, `ledger`, `error`, and `raw_payload` (raw XDR base64 for debugging).

### Diagnose a quarantine failure

1. Note the `error` field. Common errors:
   - `"unknown event type"` — the contract emitted a new event type not in the decoder; update `eventIndexer.ts`.
   - `"invalid XDR"` — raw payload is malformed; check the RPC response for the specific ledger.
   - `"schema mismatch"` — contract was upgraded with a new event value structure; update the decoder and re-run (see 6.1).

2. Decode the raw payload manually to inspect it:
   ```bash
   node -e "
     const xdr = require('@stellar/stellar-sdk').xdr;
     const raw = Buffer.from('<RAW_PAYLOAD_BASE64>', 'base64');
     console.log(JSON.stringify(xdr.DiagnosticEvent.fromXDR(raw)));
   "
   ```

3. Add a test case reproducing the quarantine failure before fixing.

### 6.1 Reprocessing after a fix

Once the decoding bug is fixed and deployed:

**Reprocess a single event:**
```bash
curl -X POST \
  http://localhost:3001/api/admin/indexer/quarantine/<event_id>/reprocess \
  -H "x-api-key: ${INTERNAL_API_KEY}"
```

**Bulk reprocess all:**
```bash
curl -X POST \
  http://localhost:3001/api/admin/indexer/quarantine/reprocess-all \
  -H "x-api-key: ${INTERNAL_API_KEY}"
```

Events that fail again remain in quarantine with an updated `error` field.

---

## 7. RPC Outage Recovery

### Symptoms

- `/api/indexer/status` returns `rpc_status: "unreachable"`.
- Logs show repeated timeouts or `ERR_HTTP_REQUEST` from the Soroban RPC endpoint.

### Steps

1. **Verify RPC availability** independently:
   ```bash
   curl -X POST https://soroban-testnet.stellar.org \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
   ```
   A healthy response returns `{"status":"healthy"}`.

2. **Failover to a secondary RPC** if configured:
   - Update `STELLAR_RPC_URL` in the backend environment.
   - Pause the indexer, update the env, then resume:
     ```bash
     curl -X POST http://localhost:3001/api/admin/indexer/pause \
       -H "x-api-key: ${INTERNAL_API_KEY}"
     # Update STELLAR_RPC_URL in .env or container env, then restart backend
     docker compose restart backend
     ```

3. **If no secondary RPC is available:**
   - Pause the indexer (section 4).
   - Monitor the RPC provider's status page.
   - Resume once the RPC is healthy — the gap is caught up automatically.

4. **If the outage exceeds 1 hour:**
   - After the RPC recovers, verify `last_indexed_ledger` and the current Stellar ledger.
   - Run `reindex-ledger-range` (section 5) over the outage window to ensure no events were missed.

---

## 8. Corrupted `indexer_state`

If `last_indexed_ledger` is accidentally set to a future ledger or an inconsistent value, the indexer will skip events.

### Diagnose

```sql
SELECT
  last_indexed_ledger,
  (SELECT MAX(ledger) FROM contract_events) AS max_event_ledger,
  last_indexed_ledger - (SELECT MAX(ledger) FROM contract_events) AS drift
FROM indexer_state;
```

Positive `drift` means `indexer_state` is ahead of actual indexed data — events in the gap were never written.

### Fix

1. Pause the indexer.
2. Reset `last_indexed_ledger` to the last known good ledger:
   ```sql
   UPDATE indexer_state
   SET last_indexed_ledger = (SELECT MAX(ledger) FROM contract_events);
   ```
3. Resume the indexer. It will re-fetch and upsert the gap automatically.

---

## 9. Recovery Checklist

Use this checklist at the start of any indexer incident:

- [ ] Check `/api/indexer/status` for `status`, `rpc_status`, `last_indexed_ledger`
- [ ] Compare `last_indexed_ledger` to current Stellar ledger — is the gap acceptable?
- [ ] Run the ledger gap query (section 2.1) to find missing ranges
- [ ] Check backend logs for error patterns (section 3)
- [ ] Check quarantine count — is it rising?
- [ ] Pause the indexer before making any corrective writes (section 4)
- [ ] Apply the appropriate fix:
  - Lag / crash → resume the indexer (section 4)
  - Gap in events → `reindex-ledger-range` (section 5)
  - Quarantine spike → diagnose and reprocess (section 6)
  - RPC outage → failover or wait (section 7)
  - Corrupt `indexer_state` → reset and resume (section 8)
- [ ] Re-run the gap query to confirm the fix
- [ ] Verify loan state and credit scores are consistent (section 2)
- [ ] Resume the indexer and confirm lag returns to normal

---

## 10. Escalation

For issues that cannot be resolved with the steps above, escalate via the [contributor Telegram group](https://t.me/+DOylgFv1jyJlNzM0).

When escalating, include:
- Indexer status JSON (`/api/indexer/status` output)
- Ledger range of any gap
- Relevant backend log excerpts (redact all secrets and PII)
- Steps already attempted

## Related Documentation

- [Indexer Sync Flow](../wiki/indexer-sync-flow.md)
- [Indexer Recovery Runbook](indexer-recovery.md)
- [Troubleshooting Guide](troubleshooting.md)
- [Contract Deployment and Migration Playbook](contract-deployment-migration.md)
- [Database Backup and Recovery](DATABASE_BACKUP_RECOVERY.md)
