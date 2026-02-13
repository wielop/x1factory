# Dress Rehearsal Runbook (TESTNET ONLY)

## 1. Prereqs

### TESTNET ONLY (hard rule)
- Do not run any step against mainnet.
- Required RPC: `https://rpc.testnet.x1.xyz`
- All `melt:testnet:*` and `mining:testnet:*` scripts are guarded and will fail if `ANCHOR_PROVIDER_URL` is not exactly testnet.

### Required env vars
Set these before running:

```bash
export ANCHOR_PROVIDER_URL=https://rpc.testnet.x1.xyz
export ANCHOR_WALLET=~/.config/solana/id.json

export MELT_V1_PROGRAM_ID=<MELT_PROGRAM_ID>
export MINING_V2_PROGRAM_ID=<MINING_PROGRAM_ID>
export MIND_MINT=<MIND_MINT>

# Optional defaults used by migration scripts
export MELT_FUNDING_BPS=9500
export MELT_CAP_XNT=10
export MELT_WINDOW_SEC=600
export MELT_ROLLOVER_BPS=2000
export MELT_BURN_MIN_MIND=10
```

### DNS / RPC checks

```bash
nslookup rpc.testnet.x1.xyz
curl -sS https://rpc.testnet.x1.xyz -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
solana cluster-version -u https://rpc.testnet.x1.xyz
solana config get
```

Expected:
- DNS resolves.
- JSON-RPC returns valid JSON (`ok` or equivalent health response).
- `solana cluster-version` returns a version without connection errors.

## 2. Build (local)

```bash
cd /home/wielop/mining
anchor build --program-name melt_v1
anchor build --program-name mining_v2
```

## 3. Deploy (testnet only)

Always pin both: `--provider.cluster https://rpc.testnet.x1.xyz` and `--program-name`.

```bash
cd /home/wielop/mining
anchor deploy --program-name melt_v1 --provider.cluster https://rpc.testnet.x1.xyz
anchor deploy --program-name mining_v2 --provider.cluster https://rpc.testnet.x1.xyz
```

### Sanity check programId

```bash
cd /home/wielop/mining
anchor keys list
solana address -k target/deploy/melt_v1-keypair.json
solana address -k target/deploy/mining_v2-keypair.json

solana program show <MELT_PROGRAM_ID> -u https://rpc.testnet.x1.xyz
solana program show <MINING_PROGRAM_ID> -u https://rpc.testnet.x1.xyz
```

Expected:
- Program IDs match what you configured in env and scripts.
- `solana program show` resolves program accounts on testnet.

## 4. Migrations

### 4.1 mining_v2 config migrate + MELT config set

Dry-run:

```bash
cd /home/wielop/mining
yarn mining:testnet:melt-migrate --dry-run \
  --melt-program-id <MELT_PROGRAM_ID> \
  --funding-bps 9500 \
  --enabled true
```

Real:

```bash
cd /home/wielop/mining
yarn mining:testnet:melt-migrate \
  --melt-program-id <MELT_PROGRAM_ID> \
  --funding-bps 9500 \
  --enabled true
```

Expected output includes:
- `cluster`, `programId`, `configPda`, `admin`
- `current_melt`, `target_melt`
- On real run: `migrate_sig`, `set_melt_sig`, `after`

### 4.2 melt_v1 config migrate + params set

Dry-run:

```bash
cd /home/wielop/mining
yarn melt:testnet:migrate --dry-run \
  --cap-xnt 10 \
  --window-sec 600 \
  --rollover-bps 2000 \
  --burn-min-mind 10
```

Real:

```bash
cd /home/wielop/mining
yarn melt:testnet:migrate \
  --cap-xnt 10 \
  --window-sec 600 \
  --rollover-bps 2000 \
  --burn-min-mind 10
```

Expected output includes:
- `cluster`, `programId`, `configPda`, `admin`
- `current`, `target`
- On real run: `migrate_sig`, `set_params_sig`, `after`

## 5. E2E Tests

Run full scenarios with `buy_contract` funding enabled:

```bash
cd /home/wielop/mining
RUN_BUY_CONTRACT=1 yarn melt:testnet:scenarios
```

Expected PASS markers in output:
- `1_PASS` topup / buy_contract increases vial
- `2_PASS` auto-start at cap with `RoundStarted`
- `3_PASS` burn in active round
- `4_PASS` finalize after `end_ts`
- `5_PASS` pro-rata claim verified by both:
  - `delta + fee` from claim tx
  - vault lamports delta
- `6_PASS` funding during active round increases NEXT vial only
- `7_PASS` rollover does not enter vial
- final: `ALL_PASS`

## 6. UI Smoke

Open `/melt` in x1mining UI and verify:
- Current vial progress for next round is visible.
- Active round pot and countdown are visible (target window 600s).
- Auto-start status text is visible (starts at cap).
- No manual public start action (only admin/test controls).
- Admin params shown: `cap`, `window`, `rollover`, `burn_min`, `funding_bps`.

Check buy_contract inflow -> vial:
1. Note current vial value.
2. Execute one `buy_contract` transaction (with MELT enabled and funding bps set).
3. Refresh `/melt`.
4. Confirm vial increased by expected MELT share.

## 7. Rollback / Recovery (testnet)

If migration fails:
1. Re-run dry-run and verify target params/program IDs.
2. Re-run real migration with corrected args.
3. If account layout mismatch persists, execute `admin_migrate_config` path again through migration scripts.
4. If config is missing/corrupted on testnet only: re-init testnet config and re-apply params.

How to find latest signatures:
- Migration scripts print `migrate_sig`, `set_melt_sig`, `set_params_sig`.
- Scenario scripts print step signatures (`*_PASS` blocks).
- You can inspect any tx with:

```bash
solana confirm <SIG> -u https://rpc.testnet.x1.xyz -v
```

