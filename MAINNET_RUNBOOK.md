# Mainnet runbook (mining_v2)

## Srodowisko
- RPC: https://rpc.mainnet.x1.xyz
- Program ID: z `target/deploy/mining_v2-keypair.json`
- Wallet deploy/admin: ten sam dla deploy i init
- Upgrade authority: zostaje u admina (bez multisig)

## Tokeny i vaulty
- MIND mint: nowy na mainnet (decimals: 9)
- MIND mint authority: vault PDA
- Burn vault: incinerator
- Treasury vault: ATA admina
- XNT: wSOL (mint `So11111111111111111111111111111111111111112`)

## Konfiguracja (domyslne parametry)
- emission: 10_000 MIND / dzien
- max_effective_hp: 250
- seconds_per_day: 86_400 (24h, do zmiany po deployu przez admin update)
- rig buff cap: 15%

## Przed deployem
1) (Opcjonalnie) jesli chcesz nowy Program ID, wygeneruj nowy keypair:
   `solana-keygen new -o target/deploy/mining_v2-keypair.json`
   - Potem zaktualizuj `Anchor.toml`, `web/lib/solana.ts` i `MAINNET_DATA.md`.
2) Ustaw zmienne srodowiskowe:
   - `RPC_URL=https://rpc.mainnet.x1.xyz`
   - `WALLET=~/.config/solana/id.json`
   - `NEXT_PUBLIC_PROGRAM_ID=<program_id_z_keypair>`
3) Sprawdz `UNSTAKE_BURN_BPS` w `programs/mining_v2/src/lib.rs` (powinno byc 6%).

## Deploy + init
1) Deploy:
   - `yarn mainnet:deploy`
2) Zapisz output adresow do `MAINNET_DATA.md`.
3) Rig buff (wymaga `RIG_BUFF_MIND_PER_HP_PER_DAY`):
   - `ts-node scripts/mainnet-v2-init-rig-buff.ts`
4) (Opcjonalnie) Przelicz network HP:
   - `ts-node scripts/mainnet-v2-recalc-network-hp.ts`
5) (Opcjonalnie) Zmiana `seconds_per_day` po deployu:
   - panel `/admin` → Update config → Seconds per day

## Web (Vercel)
- `NEXT_PUBLIC_RPC_URL=https://rpc.mainnet.x1.xyz`
- `NEXT_PUBLIC_PROGRAM_ID=<program_id_z_keypair>`
- (opcjonalnie) `NEXT_PUBLIC_RPC_PROXY=/api/rpc`
- `NEXT_PUBLIC_MELT_RPC_URL=https://rpc.mainnet.x1.xyz`
- `NEXT_PUBLIC_MELT_PROGRAM_ID=<melt_v1_program_id>`
- `NEXT_PUBLIC_MIND_MINT=<mainnet_mind_mint>`

## MELT cutover (mainnet)
### 1) Deploy MELT program
- `anchor build --program-name melt_v1`
- `anchor deploy --program-name melt_v1 --provider.cluster https://rpc.mainnet.x1.xyz`

### 2) Set MELT config first (before enabling in mining_v2)
Set env:
- `export ANCHOR_PROVIDER_URL=https://rpc.mainnet.x1.xyz`
- `export MELT_V1_PROGRAM_ID=<melt_v1_program_id>`
- `export MELT_CAP_XNT=10`
- `export MELT_WINDOW_SEC=600`
- `export MELT_ROLLOVER_BPS=2000`
- `export MELT_BURN_MIN_MIND=10`

Run:
- `yarn melt:mainnet:migrate --dry-run --cap-xnt 10 --window-sec 600 --rollover-bps 2000 --burn-min-mind 10`
- `yarn melt:mainnet:migrate --cap-xnt 10 --window-sec 600 --rollover-bps 2000 --burn-min-mind 10`

### 3) Wire mining_v2 -> MELT (still dry-run first)
Set env:
- `export MINING_V2_PROGRAM_ID=<mining_v2_program_id>`

Run:
- `yarn mining:mainnet:melt-migrate --dry-run --melt-program-id <melt_v1_program_id> --funding-bps 9500 --enabled true`
- `yarn mining:mainnet:melt-migrate --melt-program-id <melt_v1_program_id> --funding-bps 9500 --enabled true`

### 4) Go-live checks
- Verify one `buy_contract` increases MELT vial.
- Verify round lifecycle: `LIVE -> ENDED -> FINALIZED -> CLAIM`.
- Keep `melt_enabled=false` rollback command ready:
  - `yarn mining:mainnet:melt-migrate --melt-program-id <melt_v1_program_id> --funding-bps 9500 --enabled false`

## Post-deploy check
- `V2_SMOKE_BUY=1 V2_SMOKE_CLAIM=1 V2_SMOKE_STAKE=1 yarn mainnet:smoke`
- Zweryfikuj config na chainie oraz dane w `MAINNET_DATA.md`.

## Staking / epoch
- `roll_epoch`: admin-only
- Dlugosc epoki ustawiasz w panelu admina (seconds). Zalecane: `seconds_per_day * 14`.
- Cron off-chain: uruchamiac `roll_epoch` co 24h
