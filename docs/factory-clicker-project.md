# Factory Clicker Project

Factory Clicker is the MIND FACTORY retention game where users generate claimable MIND by clicking inside Telegram, then claim that MIND from a funded treasury by paying XNT from a separate clicker wallet.

The core idea is simple:

- users click to build production,
- production becomes claimable MIND,
- claiming MIND costs XNT from the clicker wallet,
- claimed MIND is paid out to the user's registered payout wallet,
- XNT is collected by the treasury wallet.

This keeps the game tied to the existing bot, wallet registration, season system, and registered-wallet payout flow.

## Product Goal

Factory Clicker should:

- give users a daily reason to open the bot,
- create a clear XNT sink,
- pay out MIND from a funded treasury,
- feed season rankings through Factory XP or production stats,
- stay simple enough to run entirely inside Telegram.

## Treasury Model

The project uses one operator-controlled treasury wallet that can hold both tokens:

- MIND reserve for payouts,
- XNT reserve collected from claims and upgrades.

Initial treasury seed:

- `5000 MIND`

Users do not receive MIND directly for free clicks. They first build a claimable balance in the bot, then top up the clicker wallet with XNT to release that balance from the treasury into the payout wallet registered at season start.

## Price Model

Reference exchange rate:

- `1 MIND = 0.075 XNT`

That number is the economic reference point, not the mandatory claim price.

Launch claim pricing is intentionally more user-friendly:

- standard claim: `0.050 XNT / 1 MIND`
- bulk claim: `0.045 XNT / 1 MIND`
- maxed claim terminal: `0.040 XNT / 1 MIND`

This keeps the game attractive for users while preserving a meaningful XNT sink for the treasury.

## Core Loop

1. User opens `Factory Clicker`.
2. User taps `Run Factory`.
3. The bot increases the user's claimable MIND balance.
4. User taps `Claim MIND`.
5. The bot calculates the XNT cost.
6. User pays XNT from the clicker wallet.
7. The bot confirms payment.
8. The bot sends MIND from treasury to the user's registered payout wallet.

## Recommended MVP Flow

The MVP should avoid full wallet-connect complexity and work with the current registered-wallet model.

Recommended flow:

1. User already has a registered payout wallet in the bot.
2. User clicks production in the bot.
3. User clicks `Claim MIND`.
4. Bot shows the required XNT amount and the clicker wallet address.
5. User sends XNT manually to the clicker wallet.
6. Scanner detects the XNT transfer.
7. Bot marks the claim as paid, or an admin settles it after the funding wallet top-up is verified.
8. Bot pays MIND to the registered payout wallet.

This is the simplest flow that fits the current project without introducing a full front-end wallet connect layer.

## Production Model

Suggested starting balance:

- Each click produces a small amount of claimable MIND.
- Click output should be small enough that the game feels active, not inflationary.
- Production should be capped per day.

Suggested starting numbers:

- `1 click = 0.02 MIND`
- `50 free clicks per day`
- `1.0 MIND maximum free daily production`

That means a user can generate a small amount of MIND every day and then decide whether to top up the clicker wallet with XNT to claim it.

## Claim Model

Claiming should be batch-based, not per-click.

Suggested claim rules:

- minimum claim size: `1 MIND`
- claim fee: `claimable MIND * 0.050 XNT` at standard tier
- claim expires only when paid or explicitly cancelled
- partial claims are not allowed in MVP

Example:

- user has `1.6 MIND` claimable,
- claim cost is `0.080 XNT`,
- bot rounds up to a practical onchain amount if needed,
- after payment, the full `1.6 MIND` is sent to the user.

## Factory XP Relationship

Factory Clicker should not replace the season system. It should sit beside it.

Recommended split:

- `Factory XP` is the season ranking score,
- `MIND` is the payout token from the clicker,
- `XNT` is the payment token that unlocks the payout,
- onchain X1Factory activity continues to generate meaningful season progress.

This keeps the clicker fun without letting it dominate the whole bot.

## Upgrade Ideas

Upgrades are part of the progression layer, but they should stay optional and readable. The intended tree is:

- `Reactor Core` - more MIND per tap
- `Fuel Cell` - more daily energy
- `Claim Terminal` - cheaper claims
- `Stability Module` - stronger streak bonuses and grace windows

See [Factory Clicker Economy And Progression](factory-clicker-economy.md) for the full level tree, costs, and strategy notes.

## Anti-Abuse

- One active claim at a time.
- Daily click cap.
- Daily claim cap.
- Payment timeout for pending claims.
- Registered-wallet requirement.
- Only one payout destination per user.
- No free infinite loop.

## Treasury Safety

- Keep a reserve floor in the treasury.
- If treasury MIND drops below the reserve floor, new claims pause.
- Show a clear status message when claims are paused.
- Admins should be able to top up treasury reserve manually.

## Data Model

Suggested tables:

- `ClickerProfile`
- `ClickerSession`
- `ClickerClaim`
- `TreasuryConfig`

Suggested tracked fields:

- `userId`
- `clickerWalletId`
- `payoutWalletId`
- `seasonId`
- `claimableMind`
- `dailyClicks`
- `lastClickAt`
- `pendingClaimMind`
- `requiredXnt`
- `paymentStatus`
- `payoutTxHash`

## Public UX

The public bot should expose only the important actions:

- `Run Factory`
- `Claim MIND`
- `My Factory`
- `Season`
- `Leaderboard`
- `How It Works`

Everything should be button-driven.

## Recommendation

This is a good second phase after the current season bot is stable.

Build order:

1. Factory Clicker UI and claim balance.
2. Manual XNT payment detection.
3. Treasury payout flow for MIND.
4. Optional boosts and streaks.
5. Later, if needed, a mini app wallet-connect experience.

See also:

- [Factory Clicker Economy And Progression](factory-clicker-economy.md)
- [Factory Clicker Flow](factory-clicker-flow.md)
