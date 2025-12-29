MAINNET RUNBOOK (draft)

Environment
- RPC: rpc.mainnet.x1.xyz
- Program ID: existing mining_v2 program keypair (target/deploy/mining_v2-keypair.json)
- Upgrade authority wallet: admin wallet (same for deploy/init)
- Upgrade authority: stays with admin (no multisig)

Token setup
- MIND mint: create new on mainnet
- MIND decimals: 9
- MIND mint authority: vault PDA
- Burn vault: default (incinerator)
- Treasury vault: default (admin ATA)
- XNT rewards: native SOL (no XNT mint)

Config params
- emission: 10,000 MIND per day
- max_effective_hp: 250
- seconds_per_day: 1,209,600 (2 weeks)

Rigs / levels / buffs
- Contract terms: default (7/14/28 days, 60/700/1500 HP, default base costs)
- Level thresholds/costs/bonus: default
- Rig buff config: default (mind_per_hp_per_day + cap)
- Rig buff cap: 15%

Staking / epochs
- roll_epoch: admin-only; fixed epoch length = seconds_per_day * 14
- Cron: off-chain bot to call roll_epoch every 24h

Code changes required before mainnet
- UNSTAKE_BURN_BPS: set to 6% (applied on testnet; redeploy on mainnet needed)
