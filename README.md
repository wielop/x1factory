# Proof-of-Commitment Mining (PoCM) Vault

Anchor program for X1 testnet that locks XNT for fixed terms (7/14/30 days) and emits a new MIND token per daily epoch. Activity is opt-in per epoch via heartbeat and rewards are capped to prevent whales.

Key rules:
- **Mining power (MP)** = weighted locked XNT (tiered diminishing returns) × time multiplier (7d=1.0, 14d=1.25, 30d=1.5) × activity (heartbeat on the epoch).
- **Daily emission** starts at 100,000 MIND/day and decays by 10% every 90 days; cannot exceed `mined_cap`.
- **Wallet cap**: effective MP in reward calc is limited to `mp_cap_bps_per_wallet` (default 2% of total epoch MP), leaving excess emission unallocated rather than mintable by admin.
- **One position per wallet**, no top-ups while locked, no early withdrawals.

## Accounts (PDAs)
- `Config` (`["config"]`): admin, mints, vault ATA, emission params, mined totals/cap, thresholds, mp cap, epoch_seconds (optionally editable), bumps.
- `Vault authority` (`["vault"]`): PDA signing for minting and vault transfers.
- `UserPosition` (`["position", user]`): lock metadata and time multiplier.
- `EpochState` (`["epoch", epoch_index_le"]`): start/end, daily emission, total_effective_mp, finalized flag.
- `UserEpoch` (`["user_epoch", user, epoch_index_le"]`): user_mp snapshot, claimed flag.

## Instructions
- `initialize(params)`: initialize config. The MIND mint (with PDA mint authority) and the vault XNT ATA are created off-chain by `scripts/init.ts`. `epoch_seconds` is normally 86,400; if `allow_epoch_seconds_edit=true`, shorter epochs also shorten lockups for testing.
- `create_position(duration_days)`: one per wallet, stores duration and multiplier.
- `deposit(amount)`: transfer XNT into the vault; only when not already locked.
- `heartbeat(epoch_index)`: activate position for the current epoch, create `EpochState` if needed, register MP (tiered thresholds, then time multiplier).
- `claim(epoch_index)`: mint MIND to user ATA; MP is capped to `mp_cap_bps_per_wallet`.
- `withdraw()`: withdraw locked XNT after `lock_end_ts` (no early exit).
- `admin_update_config`: update thresholds/mp cap and, if enabled, `epoch_seconds` (test-only flag).

## Local development
Prereqs: Rust + Anchor 0.30.x, Node 18+, yarn/ts-node.

This repo includes a `cargo` wrapper to work around an Anchor IDL-build `RUSTFLAGS` issue in this workspace:

```
yarn install          # install JS deps (requires npm registry access)
PATH="$(pwd)/scripts/cargo-wrapper:$PATH" anchor build  # builds the program + IDL
PATH="$(pwd)/scripts/cargo-wrapper:$PATH" anchor test --provider.cluster localnet
```

Tests cover init → deposit → heartbeat/claim, inactivity (no UserEpoch), whale cap, and withdraw after the shortened lock.

## Deploying to X1 testnet
```
./scripts/testnet-deploy.sh
```
Program ID: `4BwetFdBHSkDTAByraaXiiwLFTQ5jj8w4mHGpYMrNn4r`.

Configure the protocol (creates MIND mint + vault ATA off-chain, then runs `initialize`):
```
cp .env.example .env   # fill XNT_MINT, thresholds, supply, etc.
yarn init              # runs scripts/init.ts
```

## CLI scripts (ts-node)
All scripts read `.env` (RPC_URL, WALLET, PROGRAM_ID, etc.).
- `yarn init` – run `initialize`.
- `yarn deposit` – creates position if missing (DURATION_DAYS env) then deposits `AMOUNT` (base units).
- `yarn heartbeat` – heartbeats current epoch (or `EPOCH_INDEX` override).
- `yarn claim` – claims for the given/current epoch.
- `yarn withdraw` – withdraws after lock expiry.

### Env hints
- `XNT_MINT` – existing XNT mint (not hardcoded).
- `TOTAL_SUPPLY_MIND` – base units for full MIND supply; `MINED_CAP_BPS` sets the emission cap percentage.
- `THRESHOLD_1/2` – base units of XNT for diminishing returns tiers.
- `ALLOW_EPOCH_EDIT=false` for production; set true with small `EPOCH_SECONDS` only for local testing (also shortens lockups).

## Notes on caps & emission
- Whale cap: reward uses `min(user_mp, total_mp * mp_cap_bps_per_wallet / 10_000)`; unused emission is not mintable elsewhere.
- Soft halving: emission ×0.9 every 90 real days (uses 86,400s days even if `epoch_seconds` is reduced for tests).
- Reward math uses u128/u64 with checked arithmetic; no floating point.
