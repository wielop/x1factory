# X1 Mainnet - Mining V2 (dane)

## RPC
- RPC: `https://rpc.mainnet.x1.xyz`

## Program / PDA
- Program ID (V2): `uaDkkJGLLEY3kFMhhvrh5MZJ6fmwCmhNf8L7BZQJ9Aw`
- Uwaga: jesli wygenerujesz nowy keypair, zaktualizuj Program ID.
- Config PDA: `9Sqvq2mY2uGbzSPHTE91xeXmBauQLxDrEbky2jgFwAxy`
- Vault authority PDA: `6oapBS6ss57sGJ2f6GEBviYaVeSAjaELmKjyURCYLL21`

## Tokeny / Vaulty
- XNT mint (native SOL): `11111111111111111111111111111111`
- MIND mint: `DohWBfvXER6qs8zFGtdZRDpgbHmm97ZZwgCUTCdtHQNT`
- StakingRewardVault (XNT): `67L9qVDsfbtKYBwcCK9z9icL1drkwmHi3kcmpybfYYdu`
- TreasuryVault (XNT): `7483LK6WKoNBkmdDbgyVbETDxa366QV6vQkWy5xbhDwv`
- StakingMindVault (MIND): `FsUNNYax2iwi3PPuBMfzqfj2aSqcsbwMw9e8bB71tPLM`
- LevelConfig PDA: `3nBhbSXU37N86RAGXAsns3W7HGkAXW58YK1qd24nem3a`
- RigBuffConfig PDA: `CFzvwbjasxbkzKxpqNXK9zuY52AqjvwYKBabD21hUczz`

## Web (Vercel)
- `NEXT_PUBLIC_RPC_URL=https://rpc.mainnet.x1.xyz`
- `NEXT_PUBLIC_PROGRAM_ID=uaDkkJGLLEY3kFMhhvrh5MZJ6fmwCmhNf8L7BZQJ9Aw`
- `NEXT_PUBLIC_MELT_RPC_URL=https://rpc.mainnet.x1.xyz`
- `NEXT_PUBLIC_MELT_PROGRAM_ID=HAWdiMtvTfiFhENgxPdWEgBQmoa3A5oN1KV9N3LSmxXz` (or deployed mainnet MELT ID)
- `NEXT_PUBLIC_MIND_MINT=DohWBfvXER6qs8zFGtdZRDpgbHmm97ZZwgCUTCdtHQNT`

## MELT
- Program ID (v1): `HAWdiMtvTfiFhENgxPdWEgBQmoa3A5oN1KV9N3LSmxXz`
- Config PDA: `AP1hGsQQSJWAueMUuCRRuo4odCtL8TrbafMb4cB7SyZu` (seed: `melt_config`)
- Vault PDA: derived from seed `melt_vault`
