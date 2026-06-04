# Factory Clicker Idea

Factory Clicker is a simple daily engagement game for MIND FACTORY. It is inspired by lightweight Telegram clicker games, but should stay smaller, cleaner and tied to the existing season system.

## Core Loop

1. User opens the bot.
2. User taps `Run Factory`.
3. Each tap generates a small amount of Factory XP.
4. Daily taps are limited.
5. XNT can be used to boost production, restore energy or unlock temporary upgrades.

## Free Daily Activity

- Free taps per day: 50.
- Base reward per tap: 1 Factory XP.
- Daily free max: 50 Factory XP.
- Resets once per UTC day.

## XNT Utility

XNT should not feel like a required tax for casual users. It should feel like optional factory fuel.

Possible XNT actions:

- `Overdrive`: spend XNT to multiply tap output for a short period.
- `Energy Pack`: spend XNT to restore extra taps for the day.
- `Factory Upgrade`: spend XNT to unlock a season-limited production bonus.
- `Industrial Shift`: spend XNT to boost daily active rig XP for 24 hours.

## Example Balancing

- `Overdrive 10m`: 10 XNT, taps produce 3 Factory XP instead of 1.
- `Energy Pack`: 15 XNT, adds 25 extra taps today.
- `Industrial Shift`: 50 XNT, +10% daily active Factory XP for 24h.
- `Factory Upgrade`: 100 XNT, +5% Factory Clicker output for the current season.

## Anti-Abuse

- Daily tap limit.
- Cooldown between taps or batched tapping button.
- Per-user rate limits.
- No unlimited XP loop.
- XNT boosts should have clear caps.

## Rewards

- Factory XP.
- Seasonal badges.
- Production streaks.
- Optional leaderboard category: `Most Productive Operator`.
- See [Factory Clicker Economy And Progression](factory-clicker-economy.md) for the current level tree, claim fee model, and strategy split.

## Why It Fits MIND FACTORY

Factory Clicker gives users a daily reason to open the Telegram bot even when they do not have a new onchain event. It should be treated as a light engagement layer, while onchain X1Factory activity remains the primary source of meaningful Factory XP.

## Recommendation

Factory Clicker is the current focus. It gives a clean Telegram-native loop, fits the registered-wallet payout model, and keeps XNT as optional fuel while paying MIND from treasury.

Lucky Grid stays as a separate concept for later if the team wants a more explicit risk game.
