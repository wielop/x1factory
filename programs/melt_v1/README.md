# MELT Auction v1 (Testnet MVP)

Minimalny program Anchor dla rund aukcyjnych MELT (pro-rata) na testnet. Program jest odseparowany od `mining_v2` i uzywa natywnego XNT (lamports) w vault.

## Deploy na testnet

1) Ustaw program ID (testnet) w `Anchor.toml`:
   - `[programs.testnet].melt_v1 = "<PROGRAM_ID>"`

2) Zbuduj:

```bash
cd /home/wielop/mining
anchor build
```

3) Deploy tylko na testnet (bez wpisow mainnet):

```bash
ANCHOR_PROVIDER_URL=https://rpc.testnet.x1.xyz \
ANCHOR_WALLET=~/.config/solana/id.json \
anchor deploy --provider.cluster testnet
```

## Testowy flow (topup -> start -> burn -> finalize -> claim)

Ponizszy flow zaklada, ze masz klienta Anchor/TS/CLI do wywolan instrukcji:

1) `init_melt` z parametrami MVP:
   - `vault_cap_lamports = 150 * 1e9`
   - `rollover_bps = 2000`
   - `round_window_sec = 86400` (na testnet mozesz skrocic)
   - `burn_min = 10 * 1e9` (base units)
   - `test_mode = true`

2) `admin_topup_vault(lamports)` -- zasil vault natywnym XNT.

3) (opcjonalnie) `admin_set_schedule(start_ts, end_ts)` -- ustaw krotsze okno na testy.

4) `start_round` -- uruchom runde.

5) Uzytkownik: `burn_mind(amount)` -- spala MIND przez SPL burn z wlasnego ATA.

6) Po koncu okna: `finalize_round` -- wylicza `v_round` i `v_pay`.

7) Uzytkownik: `claim` -- odbiera pro-rata XNT z vault.

Uwagi:
- `admin_withdraw_vault` dziala tylko gdy `test_mode = true`.
- MIND mint pobierany jest z konfiguracji `MeltConfig` i weryfikowany w instrukcji burn.
