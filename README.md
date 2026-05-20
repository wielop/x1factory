# x1factory-seasons-bot

TypeScript Telegram bot for an X1Factory seasonal points layer, built without modifying the X1Factory app or smart contract.

## Features

- `/start`
- `/play`
- `/help`
- `/register`
- `/clicker`
- `/profile`
- `/season`
- `/leaderboard`
- `/alltime`

The bot persists wallet registrations, seasons, detected onchain events, points, rankings, and profile stats in Prisma/PostgreSQL. A real X1Factory scanner can be enabled with environment variables and awards season points from supported onchain activity.

Admin commands:

- `/admin_startseason`
- `/admin_endseason`
- `/admin_status`
- `/admin_addpoints`
- `/admin_removepoints`
- `/admin_event`
- `/admin_eventtypes`
- `/admin_scanner_status`
- `/admin_scanner_once`
- `/admin_scan_wallet`
- `/admin_set_wallet`
- `/admin_broadcast`

## Stack

- `telegraf`
- `prisma` + `@prisma/client`
- `postgresql`
- `dotenv`
- `tsx`
- `pino`
- Telegram Mini App shell for X1Factory Reactor Rush

## Project structure

```text
src/
  admin/
  bot/
  commands/
  config/
  db/
  scanner/
  services/
```

## Supabase Setup

Use `.env.local` for local development. The project loads `.env.local` first when it exists, then falls back to `.env` for any missing values.

Required variables:

- `DATABASE_URL` - pooled Supabase connection string for app/runtime queries
- `DIRECT_URL` - direct Supabase connection string used by Prisma for schema operations
- `BOT_TOKEN` - Telegram bot token from BotFather
- `ADMIN_TELEGRAM_IDS` - comma-separated Telegram admin IDs

Scanner variables:

- `X1_SCANNER_ENABLED` - set to `true` to run the automatic scanner with the bot
- `X1_SCANNER_INTERVAL_SECONDS` - scanner interval in seconds
- `X1_RPC_URL` - X1 RPC endpoint; defaults to mainnet RPC when omitted
- `X1FACTORY_PROGRAM_ID` - X1Factory/mining program ID; defaults to the current mainnet program when omitted
- `X1FACTORY_IDL_PATH` - optional IDL path; if omitted, the bot checks local mining IDL locations
- `MIND_MINT` and `XNT_MINT` - optional mint configuration reserved for scanner/runtime integrations
- `XNT_MINT` is required for automatic Factory Clicker claim settlement from the funding wallet

Mini App variables:

- `MINI_APP_URL` - public HTTPS URL used by the Telegram Web App button, use `https://x1factory.xyz/telegrambot`
- `MINI_APP_PORT` - local Mini App server port when running `npm run web:dev`
- `MINI_APP_HOST` - local bind host for the Mini App server; defaults to `127.0.0.1`

Example local env file:

```env
DATABASE_URL="postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"
BOT_TOKEN="your_telegram_bot_token"
ADMIN_TELEGRAM_IDS="123456789,987654321"
X1_SCANNER_ENABLED=false
X1_SCANNER_INTERVAL_SECONDS=120
X1_RPC_URL="https://rpc.mainnet.x1.xyz"
X1FACTORY_PROGRAM_ID="uaDkkJGLLEY3kFMhhvrh5MZJ6fmwCmhNf8L7BZQJ9Aw"
X1FACTORY_IDL_PATH="../mining/target/idl/mining_v2.json"
MIND_MINT=""
XNT_MINT=""
MINI_APP_URL="https://x1factory.xyz/telegrambot"
MINI_APP_PORT=4174
MINI_APP_HOST="127.0.0.1"
LOG_LEVEL="info"
```

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Create your local environment file:

```bash
cp .env.example .env.local
```

Then replace the placeholders in `.env.local` with your actual Supabase password, Telegram bot token, and admin Telegram IDs.

3. Generate Prisma client:

```bash
npm run prisma:generate
```

4. Push the Prisma schema to the database:

```bash
npx prisma db push
```

5. Start local development:

```bash
npm run dev
```

The bot will read environment variables from `.env.local` first.

To run the Reactor Rush Mini App locally in a separate terminal:

```bash
npm run build
npm run web:dev
```

6. Build production bundle:

```bash
npm run build
```

7. Start production build:

```bash
npm run start
```

## Notes

- `/register` persists the Telegram user and active wallet in PostgreSQL.
- `/profile`, `/leaderboard`, and `/alltime` read real database stats.
- `/play` opens X1Factory Reactor Rush at `https://x1factory.xyz/telegrambot`.
- `/telegrambot` serves the new Reactor Rush Mini App. `/reactor` is kept as an alias.
- Seasons default to `21` days with a `7` day break.
- `Season 0` is treated as a test season in user-facing messaging.
- The scanner supports purchases, renewals, daily active rigs, daily MIND claim thresholds, and stake milestones.
- Automatic scanner awards are constrained to the active season window.
- Missing transaction `blockTime` is treated as diagnostic-only and does not award points automatically.

## Telegram Mini App

BotFather `/setmenubutton` can be used to pin the Mini App:

```text
Button text: Reactor Rush
URL: https://x1factory.xyz/telegrambot
```

Reactor Rush validates Telegram Mini App `initData` server-side with `BOT_TOKEN`. The token is never exposed to frontend code. Opening the page outside Telegram shows preview mode only.

## Game Docs

- [Zasady gry](docs/zasady-gry.md)
- [Instrukcja gry](docs/instrukcja-gry.md)
- [Regulamin](docs/regulamin.md)
- [Checklista startu Season 1](docs/checklista-startu-season-1.md)
- [Factory Clicker Project](docs/factory-clicker-project.md)
- [Factory Clicker Economy And Progression](docs/factory-clicker-economy.md)
- [Factory Clicker Spec Draft](docs/factory-clicker-spec.md)
- [Factory Clicker Flow](docs/factory-clicker-flow.md)
- [Factory Clicker Mini App Plan](docs/factory-clicker-mini-app-plan.md)
