# Factory Clicker Economy And Progression

This document defines the core economy, the upgrade tree, and the intended player strategies for Factory Clicker.

## Economic Baseline

- Treasury seed: `5000 MIND`
- Season length: `21 days`
- Reference value: `1 MIND = 0.075 XNT`
- Launch claim prices:
  - standard: `0.050 XNT / 1 MIND`
  - bulk: `0.045 XNT / 1 MIND`
  - maxed terminal: `0.040 XNT / 1 MIND`

Interpretation:

- `MIND` is the progression and payout token.
- `XNT` is the friction token that unlocks claims.
- Upgrades are paid in `MIND`, not XNT.
- The claim fee is the main treasury sink.

## Design Goals

- Casual users should feel progress within one session.
- Active users should have a reason to return every day.
- Optimizers should have real choices: output, energy, claim fee, streak safety.
- Treasury should be protected by caps, fees, and upgrade sinks.

## Capacity Rule Of Thumb

If a fully active user averages about `2 MIND / day`, then:

- `5000 MIND` covers roughly `2500 user-days`
- over `21 days`, that is about `119 fully active users`

That is why the economy must stay conservative and why claim fees plus upgrade sinks matter.

## Progression Model

Player level should be `Operator Level`.

XP sources:

- taps
- claims
- daily login
- streak maintenance
- seasonal tasks

Unlock order:

- `Reactor Core` at level 1
- `Fuel Cell` at level 2
- `Claim Terminal` at level 4
- `Stability Module` at level 6

## Upgrade Tree

### 1. Reactor Core

Effect: increases MIND per tap.

| Level | Cost in MIND | Output |
| --- | ---: | --- |
| 1 | 0 | 1 MIND per 20 taps |
| 2 | 25 | 1 MIND per 19 taps |
| 3 | 50 | 1 MIND per 18 taps |
| 4 | 90 | 1 MIND per 17 taps |
| 5 | 150 | 1 MIND per 16 taps |
| 6 | 240 | 1 MIND per 15 taps |
| 7 | 360 | 1 MIND per 14 taps |
| 8 | 520 | 1 MIND per 13 taps |
| 9 | 740 | 1 MIND per 12 taps |
| 10 | 1000 | 1 MIND per 10 taps |

### 2. Fuel Cell

Effect: increases daily energy and slightly improves regen.

| Level | Cost in MIND | Energy / Regen |
| --- | ---: | --- |
| 1 | 0 | 40 energy, 1 per 10 min |
| 2 | 20 | 50 energy, 1 per 10 min |
| 3 | 45 | 60 energy, 1 per 10 min |
| 4 | 80 | 70 energy, 1 per 9.5 min |
| 5 | 130 | 80 energy, 1 per 9.5 min |
| 6 | 210 | 90 energy, 1 per 9 min |
| 7 | 330 | 100 energy, 1 per 9 min |
| 8 | 500 | 110 energy, 1 per 8.5 min |
| 9 | 740 | 120 energy, 1 per 8.5 min |
| 10 | 1100 | 140 energy, 1 per 8 min |

### 3. Claim Terminal

Effect: lowers claim fee and unlocks bulk-claim convenience.

| Level | Cost in MIND | Claim Fee |
| --- | ---: | --- |
| 1 | 0 | 0.050 XNT / MIND |
| 2 | 30 | 0.049 XNT / MIND |
| 3 | 70 | 0.048 XNT / MIND |
| 4 | 130 | 0.047 XNT / MIND |
| 5 | 220 | 0.046 XNT / MIND, bulk claim unlocked |
| 6 | 350 | 0.045 XNT / MIND |
| 7 | 520 | 0.044 XNT / MIND |
| 8 | 760 | 0.043 XNT / MIND |
| 9 | 1080 | 0.042 XNT / MIND |
| 10 | 1500 | 0.040 XNT / MIND, instant claim priority |

### 4. Stability Module

Effect: strengthens streak bonuses and gives grace windows.

Base streak bonuses:

- day 3: `+10%`
- day 7: `+25%`
- day 14: `+50%`

| Level | Cost in MIND | Bonus |
| --- | ---: | --- |
| 1 | 0 | no bonus |
| 2 | 25 | +2 percentage points to streak bonuses |
| 3 | 60 | +4 pp |
| 4 | 110 | +6 pp |
| 5 | 180 | +8 pp, 12h grace / week |
| 6 | 280 | +10 pp |
| 7 | 420 | +13 pp |
| 8 | 620 | +16 pp, 1 missed day grace / 10 days |
| 9 | 900 | +20 pp |
| 10 | 1300 | +25 pp, 1 missed day grace / 7 days |

## Player Strategies

### Casual

- upgrade `Fuel Cell` first
- keep `Reactor Core` at a modest level
- claim in batches to avoid overpaying fee overhead

### Optimizer

- push `Claim Terminal` to level 5 or 6 early
- maintain streaks with `Stability Module`
- claim larger batches less often

### Grinder

- prioritize `Reactor Core`
- then `Fuel Cell`
- only later optimize claim fee

### Late Game

- max `Claim Terminal`
- max `Stability Module`
- use `Fuel Cell` only as needed

## Balance Notes

- The game should never feel like a pure paywall.
- The claim fee should feel like a friction cost, not a punishment.
- Upgrade costs should be paid in `MIND` so the game has a real sink for earned value.
- The economy should favor users who come back often, not users who spam in one session.

