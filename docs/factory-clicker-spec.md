# Factory Clicker Spec Draft

Short working spec for implementation planning.

## User Story

As a registered operator, I tap to build factory output, then pay XNT to claim the MIND I produced into my registered wallet.

## Economy

- Treasury starts with `5000 MIND`.
- `1 MIND = 0.075 XNT` is the reference value.
- Launch claim prices are intentionally lower:
  - `0.050 XNT / 1 MIND`
  - `0.045 XNT / 1 MIND` for bulk/optimized claims
  - `0.040 XNT / 1 MIND` for maxed claim terminal
- Clicks create claimable MIND.
- Claiming pays out MIND and requires XNT.

Upgrades cost `MIND`, not `XNT`.

See [Factory Clicker Economy And Progression](factory-clicker-economy.md) for the level tree and strategy model.

## Gameplay

- `Run Factory` button increases claimable MIND.
- `Claim MIND` button opens a claim checkout.
- `My Factory` shows claimable MIND, daily clicks, and claim history.

## Constraints

- Only registered wallets can play.
- Only one pending claim at a time.
- Daily click cap.
- Daily claim cap.
- Treasury reserve floor.

## MVP Scope

- Telegram-only UX.
- Manual XNT payment detection.
- MIND payout to registered wallet.
- Factory XP unchanged for season ranking.

See also:

- [Factory Clicker Flow](factory-clicker-flow.md)
