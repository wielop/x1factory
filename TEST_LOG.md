# X1Factory Seasons Test Log

Last updated: 2026-05-15

## What we changed

- Real X1Factory scanner now decodes onchain instruction names using `snake_case` as well as the existing variants.
- `claim_mind_daily` now awards by daily total and sends a progress message showing:
  - last claim size
  - today's total claimed
  - current reward tier
  - points added now
  - next threshold and missing amount
- `stake_snapshot` now uses a season baseline model:
  - baseline is frozen per season
  - only growth above the baseline is eligible for stake points
  - points for the same milestone are only awarded once
  - progress messages were added for stake milestones
- `daily_active_*` is now delayed until a rig has been active for at least 24 hours from `startTs`.
- Scanner now enforces season window safety:
  - no award before season `startsAt`
  - no award after season `endsAt`
  - missing `blockTime` is diagnostic-only
- `claim_mind_daily` first reward threshold was changed to `0.000000001 MIND -> 5 points`.
- Season-level user messaging now shows a `Season 0 is for testing only. Season 1 starts from zero.` notice.
- Auto scanner is enabled in `.env.local` and currently runs at `60s`.

## Live validations completed

- Telegram bot started and responded to `/start` after restart.
- `Season 0` was started as active season after ending the previous active season.
- Prisma schema was checked with `npx prisma db push`; database is in sync with `prisma/schema.prisma`.
- `npm run build` passed after each relevant change.
- Real manual wallet scan deduplication was verified:
  - first scan on a registered wallet added points
  - second scan on the same wallet did not double-award
- `runScannerOnce` was verified on live data.
- Real purchase decoding was verified:
  - industrial purchase recognized
  - purchase points awarded correctly
- Real claim decoding was verified:
  - daily claim progress message displayed
  - claim threshold award worked at `5` points for a very small claim
- Real stake decoding was verified:
  - stake snapshot detected
  - milestone awards worked
  - milestone points were not duplicated on repeated scans
- Season-window filtering was verified:
  - events outside the season window are ignored
  - missing `blockTime` is diagnostic-only

## Wallet-specific observations

- Wallet `AHrSKaFPWxt2YMZ7Q3xxpuC4wb622C3jUhER2p1V6VZS` is registered in `Season 0`.
- The wallet is currently used as a live test wallet for claim, stake, purchase, and notification checks.
- Stake baseline for the season was initialized from the wallet's starting stake, so older stake does not receive retroactive Season 0 rewards.

## Important behavioral notes

- Purchase and renewal points are only awarded if the tx is inside the active season window.
- Existing rigs from before the season can still contribute to `daily_active_*` only after they have been active for 24 hours.
- Stake milestone rewards are cumulative and only awarded once per milestone.
- Claim rewards are daily-total based, not per-tx based.

## Current known risks / reminders

- Telegram notifications depend on the bot process staying online.
- If the bot process is restarted, notifications are unavailable until it comes back up.
- For stake notifications, the current behavior only emits progress when the stake state changes, not on every scanner cycle.

## Next test ideas

- Validate a larger claim that crosses the next claim threshold.
- Validate a stake increase that crosses the next stake milestone.
- Validate `daily_active_*` after a rig has been active for a full 24 hours.
- Validate purchase/renewal behavior at season boundaries with a known edge-case tx.
