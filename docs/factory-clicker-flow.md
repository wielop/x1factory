# Factory Clicker Flow

This document defines the Telegram user flow for Factory Clicker and the data shape needed to implement it cleanly inside the existing MIND FACTORY bot.

## Product Principle

Factory Clicker should feel like a daily game loop, not a payment form.

The public flow must:

- stay button-driven,
- keep copy short and readable,
- show progress immediately after each tap,
- make claiming feel like a reward action,
- keep XNT as the payment token that unlocks MIND payout.

## Main States

1. `idle`
   - user has no open clicker session,
   - user sees the main menu entry point.

2. `ready`
   - user has a clicker profile,
   - daily taps are available,
   - claimable MIND may be zero or greater.

3. `producing`
   - user is inside a live click session,
   - taps increase claimable MIND,
   - daily cap may be close to full.

4. `claimable`
   - user has at least the minimum amount of MIND ready to claim,
   - the bot can create a claim checkout.

5. `pending_payment`
   - the bot has created a claim,
   - XNT payment is required before payout.

6. `paid`
   - XNT payment has been confirmed,
   - MIND payout is executed or queued.

7. `paused`
   - treasury reserve is too low,
   - new claims are blocked until top-up.

## Screen 1: Entry

Entry point from the main Telegram menu:

- `Factory Clicker`

Goal:

- explain the game in one short block,
- show current claimable MIND and tap status,
- offer one primary action.

Suggested message:

```text
MIND FACTORY // FACTORY CLICKER

Tap to build claimable MIND.
Pay XNT from your clicker wallet to claim it into your registered payout wallet.

Today:
- Taps left: 42/50
- Claimable: 1.6 MIND
- Claim status: ready

[Run Factory]
[Claim MIND]
[My Factory]
[How It Works]
```

## Screen 2: Run Factory

When the user taps `Run Factory`, the bot should:

1. verify the user is registered,
2. verify the daily tap cap has not been reached,
3. increment claimable MIND,
4. store the tap event,
5. refresh the entry screen.

Suggested feedback:

```text
Factory line active.
+0.02 MIND added to your claimable balance.

Today:
- Claimable: 1.62 MIND
- Taps left: 41/50
```

The tap action should be immediate and low-friction.

## Screen 3: Claim MIND

When the user taps `Claim MIND`, the bot should:

1. check that claimable MIND meets the minimum claim size,
2. calculate the XNT cost from the current rate,
3. verify treasury reserve is healthy,
4. create a pending claim record,
5. show payment instructions.

Suggested message:

```text
MIND ready to claim.

Amount: 1.6 MIND
Rate: 0.050 XNT per 1 MIND
Cost: 0.080 XNT

Top up your clicker wallet with XNT.
After payment, the claim will unlock automatically and MIND will go to your payout wallet.

[I Paid]
[Cancel]
```

If the claim is below the minimum size:

```text
Not enough MIND to claim yet.

Minimum claim: 1 MIND
Current balance: 0.8 MIND

Run the factory a bit more.
```

## Screen 4: Payment Pending

This state exists after the claim is created and before the scanner confirms the XNT transfer.

The bot should keep the claim visible in `My Factory` and show:

- claimed amount,
- required XNT,
- timeout,
- status.

Suggested message:

```text
Claim pending.

Waiting for: 0.024 XNT
Status: payment not confirmed yet
Timeout: 10 minutes

Tap `I Paid` after sending XNT.
```

In the current implementation, the backend can also be settled manually by an admin using the clicker settlement command once the funding wallet top-up is verified.

## Screen 5: Claim Confirmed

After XNT is confirmed:

1. mark the claim as paid,
2. send MIND from treasury to the user wallet,
3. update the profile view,
4. store the payout tx hash.

Until automated payment confirmation lands, this state is reached through backend settlement rather than direct onchain settlement logic.

Suggested message:

```text
Claim confirmed.

0.024 XNT received.
1.6 MIND sent to your registered payout wallet.

Factory output secured.
```

## Screen 6: My Factory

This screen is the user’s main status page.

It should show:

- registered payout wallet,
- clicker wallet,
- claimable MIND,
- today’s taps,
- active boosts,
- pending claim status,
- recent history.

Suggested message:

```text
MIND FACTORY // MY FACTORY

Wallet: AHrS...VZS
Claimable MIND: 1.6
Today taps: 8/50
Active boost: none
Pending claim: none

Recent activity:
- +0.02 MIND - Run Factory
- +0.02 MIND - Run Factory
- claim paid - 1.6 MIND
```

## Screen 7: Boosts

Boosts are optional and must never block the free core loop.

Suggested boost cards:

- `Overdrive`
  - temporary tap multiplier,
  - paid in XNT.

- `Energy Pack`
  - restores taps for the day,
  - paid in XNT.

- `Industrial Shift`
  - boosts output for 24h,
  - paid in XNT.

Boost status should appear in `My Factory`, not as a separate confusing menu.

## Screen 8: Treasury Paused

If the treasury reserve is too low, claims must stop cleanly.

Suggested message:

```text
Claims paused.

The MIND treasury reserve is below the safety floor.
You can keep building taps, but claims will reopen after top-up.
```

## Data Model

The implementation should use a small set of records.

### ClickerProfile

One row per user.

Fields:

- `id`
- `telegramUserId`
- `clickerWalletId`
- `payoutWalletId`
- `seasonId`
- `claimableMind`
- `dailyTapsUsed`
- `dailyTapCap`
- `lastTapAt`
- `currentBoostType`
- `boostExpiresAt`
- `createdAt`
- `updatedAt`

### ClickerSession

Tracks a live tap session or daily run summary.

Fields:

- `id`
- `userId`
- `clickerWalletId`
- `seasonId`
- `sessionDate`
- `tapsUsed`
- `mindEarned`
- `xntSpent`
- `status`
- `createdAt`
- `updatedAt`

### ClickerClaim

Tracks one claim checkout from creation to payout.

Fields:

- `id`
- `userId`
- `clickerWalletId`
- `payoutWalletId`
- `seasonId`
- `claimableMind`
- `xntRequired`
- `paymentStatus`
- `paymentTxHash`
- `payoutTxHash`
- `expiresAt`
- `paidAt`
- `claimedAt`
- `cancelledAt`
- `createdAt`
- `updatedAt`

### TreasuryConfig

Global config for the clicker economy.

Fields:

- `id`
- `mindReserveFloor`
- `mindTreasuryBalance`
- `xntTreasuryBalance`
- `mindPerXntRate`
- `minimumClaimMind`
- `dailyTapCap`
- `claimTimeoutMinutes`
- `claimPaused`
- `updatedAt`

## Event Types

The clicker should emit structured events, not just text replies.

Suggested event types:

- `clicker_tap`
- `clicker_claim_created`
- `clicker_claim_paid`
- `clicker_claim_cancelled`
- `clicker_boost_purchased`
- `clicker_boost_expired`
- `clicker_treasury_paused`
- `clicker_treasury_resumed`

## Implementation Order

1. Add clicker models to Prisma.
2. Add the menu entry and public screens.
3. Add tap accounting and daily caps.
4. Add claim checkout records.
5. Add XNT payment detection.
6. Add MIND payout execution.
7. Add boosts after the core loop works.

## Acceptance Criteria

The first usable version is good enough if:

- a user can open Factory Clicker from Telegram,
- a user can tap to build claimable MIND,
- a user can see their balance and tap count,
- a user can create a claim,
- a user can pay XNT from the clicker wallet and receive MIND in the payout wallet,
- the treasury reserve guard works,
- the copy stays short and game-like.
