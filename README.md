# Mining V2 (X1)

Nowy program mining+staking V2 dla X1. V1 zostal usuniety z repo (legacy nie jest juz utrzymywany).

## Zalozenia (V2)
- Kontrakty miningowe daja Hashpower (HP) na staly czas.
- Globalna emisja MIND jest stala na dzien i dzielona pro-rata do aktywnego HP.
- Jesli `networkHpActive == 0` -> emisja jest wstrzymana (brak unallocated).
- Anti-whale: skuteczny HP per wallet jest ograniczony (`maxEffectiveHp`).
- Staking MIND wyplaca XNT z `stakingRewardVault` (30% z zakupow kontraktow).
- Badge bonus dziala jako mnoznik wyplaty usera (cap 20%), nie zmienia globalnego `rewardRate`.

## Produkty miningowe (start)
- Starter Rig: 7d, koszt 1 XNT, hp=1
- Pro Rig: 14d, koszt 10 XNT, hp=5
- Industrial Rig: 28d, koszt 20 XNT, hp=7

## Instrukcje (skrot)
- `init_config` - tworzy config + podlacza vaulty
- `buy_contract` - kupno kontraktu (split 30/70 do vaultow)
- `claim_mind` - claim MIND (mozna czesto)
- `deactivate_position` - wygaszenie kontraktu po endTs
- `stake_mind` / `unstake_mind` / `claim_xnt` / `roll_epoch`

## Narzędzia administracyjne (testnet)
- `WITHDRAW_STAKING_REWARDS_LAMPORTS=<lamports> yarn withdraw-staking-rewards` — wycofuje XNT z `stakingRewardVault` nawet gdy są aktywne stake’i; pamiętaj, że instrukcja resetuje `staking_reward_rate_xnt_per_sec`, więc po wypłacie warto ponownie rzucić `roll_epoch`.

## Local dev
```
yarn install
anchor build
yarn test
```

## Mainnet deploy + smoke
```
yarn mainnet:deploy
# opcjonalnie
V2_SMOKE_BUY=1 V2_SMOKE_CLAIM=1 V2_SMOKE_STAKE=1 yarn mainnet:smoke
```

## ENV (skrypty)
Wymagane/obslugiwane zmienne:
- `RPC_URL` (domyslnie: https://rpc.mainnet.x1.xyz)
- `WALLET` (domyslnie: ~/.config/solana/id.json)
- `NEXT_PUBLIC_PROGRAM_ID` (Program ID V2)
- `XNT_MINT` (domyslnie: So11111111111111111111111111111111111111112)
- `MIND_MINT` (opcjonalnie - jesli chcesz uzyc istniejacego mintu)
- `MIND_DECIMALS` (domyslnie: 9)
- `EMISSION_MIND_PER_DAY` (domyslnie: 10000)
- `EMISSION_PER_SEC` (opcjonalnie - nadpisuje wyliczenie per day)
- `MAX_EFFECTIVE_HP` (domyslnie: 250)
- `SECONDS_PER_DAY` (domyslnie: 86400)
- `SEED_STAKING_XNT_BASE` (opcjonalnie - seed vaulta staking)
- `SEED_TREASURY_XNT_BASE` (opcjonalnie - seed treasury)

## Web (Vercel)
Root Directory: `web`
Env vars:
- `NEXT_PUBLIC_RPC_URL=https://rpc.mainnet.x1.xyz`
- `NEXT_PUBLIC_PROGRAM_ID=uaDkkJGLLEY3kFMhhvrh5MZJ6fmwCmhNf8L7BZQJ9Aw`
