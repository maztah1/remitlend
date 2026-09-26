# Contract Deployment and Migration Playbook

This playbook covers the end-to-end process for deploying new Soroban contracts, upgrading existing ones, and running storage migrations safely across testnet and mainnet.

---

## 1. Prerequisites

Before starting any deployment or migration:

- Rust toolchain with `wasm32-unknown-unknown` target installed:
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- Soroban CLI installed:
  ```bash
  cargo install --locked soroban-cli
  ```
- Node.js ≥ 18 for the deploy script:
  ```bash
  node --version
  ```
- Admin keypair (secret key) for the target network. **Never commit this key.**
- `scripts/deploy-config.json` reviewed and up to date.
- A recent backup of the database and existing contract state (production only).

---

## 2. Building Contracts

Build all contracts for release:

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

Verify WASM sizes are within budget:

```bash
cd ..
bash scripts/check-wasm-size-regression.sh
```

If any contract exceeds its budget, run the optimizer:

```bash
bash scripts/optimize-wasm-sizes.sh
```

Sizes are tracked in `contracts/size-budgets.json`. Do not deploy a contract that exceeds its budget without first updating the budget and getting a review approval.

---

## 3. First-Time Deployment (Testnet)

Use the deploy script, which handles funding, deployment, and ID recording:

```bash
cd scripts
npm install
npx ts-node deploy.ts --network testnet
```

The script:
1. Funds the deployer account from the Stellar testnet faucet.
2. Deploys each WASM binary and prints the resulting contract IDs.
3. Initializes each contract with the values from `deploy-config.json`.

After a successful run, copy the printed contract IDs into `docs/deployed-contracts.md` and open a PR with the updated registry. Include the deploy date (YYYY-MM-DD) and the short git commit SHA.

Set the corresponding environment variables in `backend/.env` (and in CI secrets for staging):

| Contract | Env var |
|---|---|
| `loan_manager` | `LOAN_MANAGER_CONTRACT_ID` |
| `lending_pool` | `LENDING_POOL_CONTRACT_ID` |
| `remittance_nft` | `REMITTANCE_NFT_CONTRACT_ID` |
| `multisig_governance` | `MULTISIG_GOVERNANCE_CONTRACT_ID` |
| `token` | `POOL_TOKEN_ADDRESS` |

---

## 4. Upgrading an Existing Contract

Contract upgrades use the upgrade proxy with a 48-hour timelock defined in `contracts/loan_manager/src/upgrade_proxy.rs`. See `contracts/UPGRADE_PROCESS.md` for the full governance model.

### 4.1 Build the new WASM

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
bash ../scripts/check-wasm-size-regression.sh
```

### 4.2 Compute the new WASM hash

```bash
sha256sum contracts/loan_manager/target/wasm32-unknown-unknown/release/loan_manager.wasm
```

Record the hash — you will need it in step 4.4.

### 4.3 Announce the upgrade

Post a notice in the contributor Telegram group at least 48 hours before executing, including:
- Contract name and current version.
- New WASM hash.
- Summary of changes and any storage migration required.
- Expected execution ledger range.

This gives stakeholders time to review and raise concerns before the timelock expires.

### 4.4 Schedule the upgrade

```bash
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_SECRET_KEY> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- schedule_upgrade \
  --wasm_hash <NEW_WASM_HASH> \
  --migration_data null
```

If the upgrade includes a storage migration, replace `null` with the encoded migration payload. See section 5 for migration patterns.

Confirm the upgrade is scheduled:

```bash
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_SECRET_KEY> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- get_scheduled_upgrade
```

The response includes `scheduled_at` (the ledger number when the timelock expires).

### 4.5 Execute the upgrade (after timelock)

After 48 hours (~34,560 ledgers):

```bash
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_SECRET_KEY> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- execute_upgrade
```

Verify the contract is running the new WASM by checking the contract hash on the explorer:

```
https://stellar.expert/explorer/testnet/contract/<CONTRACT_ID>
```

### 4.6 Cancel an upgrade

If a problem is discovered before the timelock expires:

```bash
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_SECRET_KEY> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- cancel_upgrade
```

Announce the cancellation in the contributor channel with the reason.

---

## 5. Storage Migrations

Soroban storage is persistent across upgrades. When a new contract version introduces schema changes, you must migrate existing storage during the upgrade execution.

### 5.1 Migration patterns

**Additive change** (new storage key, no existing key changed): no migration required. New keys are absent until first write.

**Renamed key**: write a migration function that reads the old key, writes the new key, and deletes the old key atomically within `execute_upgrade`.

**Type change on existing key**: read all existing values, transform them to the new type, and overwrite. If the dataset is large, break it into batches and use a migration cursor stored in instance storage.

**Removed key**: delete the old key explicitly during migration to recover ledger rent.

### 5.2 Writing a migration

Migrations live in the contract source as a function called from `execute_upgrade` when `migration_data` is `Some(...)`:

```rust
fn migrate_v1_to_v2(env: &Env, data: MigrationData) {
    // Example: rename DataKey::OldField to DataKey::NewField
    if let Some(old_val) = env.storage().persistent().get::<_, OldType>(&DataKey::OldField) {
        env.storage().persistent().set(&DataKey::NewField, &old_val.into_new_type());
        env.storage().persistent().remove(&DataKey::OldField);
    }
}
```

Test the migration against a forked state snapshot before scheduling in production.

### 5.3 Verifying migration correctness

After execution, spot-check storage values using `soroban contract data get`:

```bash
soroban contract data get \
  --id <CONTRACT_ID> \
  --key <STORAGE_KEY_XDR> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"
```

Run the contract integration tests against the post-migration state:

```bash
cd contracts
cargo test --lib -- migration
```

---

## 6. Database Migrations (Backend)

Contract upgrades that change event schemas or add new event types require a corresponding backend database migration. Backend migrations use `node-pg-migrate` and live in `backend/migrations/`.

### 6.1 Create a migration

```bash
cd backend
npx node-pg-migrate create <migration-name>
```

Write the `up` and `down` functions in the generated file. Always implement `down` so the migration is reversible.

### 6.2 Apply migrations

```bash
npm run migrate:up
```

### 6.3 Roll back the last migration

```bash
npm run migrate:down
```

### 6.4 Verify migration state

```bash
npm run migrate:status
```

All migrations must be applied before the backend processes events from the upgraded contract.

---

## 7. Post-Deployment Verification

After every deployment or upgrade:

1. **Update `docs/deployed-contracts.md`** with the new contract ID, deploy date, and commit SHA.
2. **Run contract verification**: follow `docs/runbooks/contract-verification.md` to register the new WASM hash on Stellar Explorer.
3. **Resume the indexer** if it was paused: see `docs/runbooks/indexer-correctness-recovery.md`.
4. **Smoke-test the API**:
   ```bash
   curl http://localhost:3001/health
   curl http://localhost:3001/api/pool/stats \
     -H "Authorization: Bearer <LENDER_JWT>"
   ```
5. **Check CI**: confirm the `contract-drift` workflow passes on the PR that updated `deployed-contracts.md`.
6. **Announce** the completed upgrade in the contributor channel with the new contract ID and explorer link.

---

## 8. Rollback

Rollback requires scheduling a new upgrade back to the previous WASM version. You cannot immediately revert — the 48-hour timelock applies to rollbacks too.

For emergencies, use the pause mechanism to stop all contract operations while the rollback upgrade is in flight:

```bash
soroban contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_SECRET_KEY> \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  -- pause
```

See `contracts/EMERGENCY_PAUSE_PATTERN.md` for the full pause/unpause procedure.

---

## 9. Mainnet Checklist

Before any mainnet deployment, verify all items in this checklist:

- [ ] Contract has passed full unit and integration tests (`cargo test`)
- [ ] WASM size is within budget (`check-wasm-size-regression.sh`)
- [ ] Contract fuzz campaign has run for ≥ 30 minutes (`contracts/FUZZING_README.md`)
- [ ] Migration script has been tested against a copy of production storage
- [ ] Backend database migration written, tested, and reviewed
- [ ] `docs/deployed-contracts.md` PR is open and approved
- [ ] Upgrade announcement posted ≥ 48 hours before execution
- [ ] Emergency pause tested on testnet
- [ ] Rollback plan documented and accessible to all on-call engineers
- [ ] Production database backup taken immediately before execution
- [ ] At least two engineers available during the execution window

---

## 10. Escalation

For issues that cannot be resolved with the steps above, escalate via the [contributor Telegram group](https://t.me/+DOylgFv1jyJlNzM0).

When escalating, include:
- Network (testnet / mainnet)
- Contract name and ID
- The scheduled upgrade ledger (if applicable)
- Steps already attempted and their outcomes
- Any on-chain transaction IDs or explorer links

## Related Documentation

- [Deployed Contract Registry](../deployed-contracts.md)
- [Upgrade Process](../../contracts/UPGRADE_PROCESS.md)
- [Emergency Pause Pattern](../../contracts/EMERGENCY_PAUSE_PATTERN.md)
- [Contract Verification Runbook](contract-verification.md)
- [Indexer Correctness and Recovery Guide](indexer-correctness-recovery.md)
- [Database Backup and Recovery](DATABASE_BACKUP_RECOVERY.md)
