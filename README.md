# x1factory-seasons-bot

Production-ready TypeScript Telegram bot scaffold for an X1Factory seasonal layer, built without modifying the X1Factory app or smart contract.

## Features

- `/start`
- `/help`
- `/register`
- `/profile`
- `/season`
- `/leaderboard`
- `/alltime`

MVP v1 uses mock points and mock leaderboard data. Wallet registration and season membership are persisted in Prisma/PostgreSQL. The scanner layer is kept modular for future integration but is not active in this MVP.

## Stack

- `telegraf`
- `prisma` + `@prisma/client`
- `postgresql`
- `dotenv`
- `tsx`
- `pino`

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

Example local env file:

```env
DATABASE_URL="postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
DIRECT_URL="postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"
BOT_TOKEN="your_telegram_bot_token"
ADMIN_TELEGRAM_IDS="123456789,987654321"
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
- `/profile`, `/leaderboard`, and `/alltime` use mock seasonal data for MVP v1.
- Seasons default to `21` days with a `7` day break.
- Only `/admin_startseason` and `/admin_endseason` are exposed in MVP v1.
- `src/scanner` is intentionally modular but not started by the app yet.
