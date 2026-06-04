# Factory Clicker Mini App Plan

This file tracks the current implementation status of Factory Clicker and the path to a real Mini App experience.

## What Is Already Done

- Public bot UX has been converted to MIND FACTORY style.
- The main menu now includes a `Factory Clicker` entry.
- The bot exposes a `/clicker` command.
- A first clicker service exists in code:
  - user profile lookup,
  - clicker dashboard state,
  - tap accounting,
  - pending claim records,
  - treasury config model.
- A Mini App shell now exists:
  - `src/web/server.ts`
  - `web/index.html`
  - `web/styles.css`
  - `web/app.js`
- The bot can open the Mini App from the clicker screen when `MINI_APP_URL` is configured.
- Prisma models have been added for:
  - `ClickerProfile`
  - `ClickerSession`
  - `ClickerClaim`
  - `TreasuryConfig`
- The database schema is synced.
- The clicker is documented in:
  - `docs/factory-clicker-project.md`
  - `docs/factory-clicker-spec.md`
  - `docs/factory-clicker-flow.md`
- The bot still runs and the scanner still starts cleanly after the new clicker work.

## What Exists Right Now

The current bot version is enough for a basic internal loop:

- a user can open the clicker screen,
- a user can open the Mini App shell,
- the user can see claimable MIND,
- the user can run the factory tap action,
- the user can create a pending MIND claim,
- the user can cancel a claim,
- the user can see clicker status inside `My Factory`.

This is not yet the final game experience.

## What Mini App Should Do

The Mini App should become the actual game surface.

It should handle:

- tap gameplay,
- energy or tap counter,
- visible claimable MIND,
- claim checkout,
- boost status,
- separate clicker wallet funding,
- wallet-aware claim flow,
- better visual feedback than chat replies.

The bot should remain the launcher and notification layer.

## What Still Needs To Be Built

### 1. Mini App shell

- Telegram Web App entry point.
- A single-page game surface.
- Auth handshake from Telegram user to backend session.
- Local server bind host / port config.

### 2. Game UI

- Large tap button.
- Claimable MIND display.
- Daily tap counter.
- Active boost display.
- Claim button.
- Treasury / payout status.

### 3. Backend endpoints

- open or resume clicker session,
- record tap,
- calculate claimable MIND,
- create pending claim,
- cancel claim,
- query dashboard state.

These are now present as the initial API layer; the remaining work is payout settlement and any additional game actions we decide to add.

The payout path is now wired through an admin settlement command, so the next step is automating payment confirmation from the clicker funding wallet.

### 4. Wallet-aware claim flow

- read the user’s registered payout wallet,
- read the user’s clicker wallet,
- calculate XNT cost,
- mark claims pending,
- confirm payment later,
- send MIND to the registered payout wallet.

The payout wallet is the season wallet the user registered at the start of the season. The clicker wallet is a separate funding wallet used only for XNT top-ups.

### 5. Fairness and limits

- daily tap cap,
- claim minimum,
- claim timeout,
- treasury reserve floor,
- anti-spam / anti-abuse protections.

### 6. Polish

- smoother wording,
- better reward feedback,
- animations or microinteractions,
- cleaner mobile layout,
- stronger game feel.

## Recommended Build Order

1. Automate payment confirmation from the clicker funding wallet.
2. Add any extra clicker actions we want beyond tap/claim/cancel.
3. Add polish and reward feedback.
4. Decide whether to introduce wallet connect or keep the current registered-wallet model.

## Final Target

The final version should feel like this:

1. User opens Telegram.
2. User taps `Factory Clicker`.
3. Telegram opens the Mini App.
4. User taps the factory button in a dedicated game screen.
5. The app updates the score immediately.
6. User claims MIND from the treasury with XNT.
7. The registered payout wallet receives the payout.
8. The bot sends follow-up messages only when needed.

That is the end state for the clicker feature.
