# x1factory-seasons-bot — Project Context

## What this project is

X1Factory Seasons — a Telegram Mini App + on-chain scanner for the X1 blockchain.

- **x1factory.xyz/** — Full MIND FACTORY website (buy rigs, staking, HP/XNT/MIND tokens)
- **x1factory.xyz/panel** — Seasons panel (Telegram WebApp, Miner's Passport, rankings, daily missions)
- **Telegram bot** — sends notifications when on-chain events are detected (rig purchase, staking, daily check-in)

---

## Architecture: TWO CODEBASES in ONE REPO

```
x1factory-seasons-bot/
├── web/          ← MIND FACTORY Next.js website (App Router, Tailwind, Solana web3)
├── src/          ← Telegram bot (TypeScript, Telegraf, tsx)
├── prisma/       ← Database schema (Prisma ORM + PostgreSQL / Supabase)
├── package.json  ← Bot scripts (dev, bot:build)
└── web/package.json ← Website scripts (npm run dev inside web/)
```

### `web/` — Next.js App Router website
- Full MIND FACTORY dApp: buy rigs, staking, leaderboard, HP/XNT/MIND tokens
- App Router at `web/app/` — this is the ONLY correct routing
- Panel HTML/CSS/JS lives in **`web/public/panel.html`**, **`web/public/panel.js`**, **`web/public/panel.css`**
- Panel API at `web/app/api/panel/me/route.ts` (App Router)
- Panel route at `web/app/panel/route.ts` (serves panel.html)
- Auth library at `web/lib/webAppAuth.ts` — has correct HMAC formula

### `src/` — Telegram bot
- Entry: `src/index.ts`
- Scanner: `src/scanner/x1FactoryScanner.ts` — polls X1 RPC every 60s
- Points service: `src/services/pointsService.ts`
- Bot UI: `src/bot/ui.ts` — 3-button keyboard: Season Panel (WebApp), Connect Wallet, How It Works

---

## CRITICAL RULES (learned the hard way)

1. **NEVER add `web/pages/index.js`** — The MIND FACTORY homepage is served by App Router (`web/app/`). Adding a pages/index.js breaks everything.
2. **ALWAYS edit `web/public/panel.*`** — NOT `web/panel.*` (root files are wrong path). Vercel serves static files from `web/public/`.
3. **ALWAYS push to `main`**: `git push origin master:main` — Vercel watches `main`, NOT master.
4. **App Router only for panel API** — `web/app/api/panel/` is correct. `web/pages/api/panel/` will conflict.
5. **HMAC formula for WebApp auth** — `createHmac('sha256', 'WebAppData').update(botToken)` NOT `createHash('sha256').update(botToken)` (that's Login Widget, not WebApp).

---

## Current git state

- **Commit:** `2c2a529` — "Integrate bot into MIND FACTORY website commit"
- `web/` = MIND FACTORY website from commit `4761f71`
- `src/` + `prisma/` = bot from commit `c578bc4`
- Both `master` and `main` are at `2c2a529`

---

## How to start the bot

```bash
# Start bot + scanner in background
nohup npm run dev >> /tmp/bot.log 2>&1 &

# Monitor logs
tail -f /tmp/bot.log

# Check if running
pgrep -a node | grep tsx
```

Bot log is at `/tmp/bot.log`. Scanner runs every 60s.

---

## Panel features (as of `4761f71` + our additions)

- **Miner's Passport tab**: operator identity, season badge, stamps, battle card
- **Season tab**: points, rank, goal bar, daily missions, prize pool
- **Rankings tab**: leaderboard (loaded on demand)
- **Auto-refresh**: every 15s via `setInterval(doRefresh, 15000)`
- **Manual refresh button**: next to the season points number (`↻` button)
- **`doRefresh()`**: fetches `/api/panel/me` AND `/api/panel/leaderboard` in parallel, updates ALL state

---

## Panel API (`web/app/api/panel/me/route.ts`) returns

```json
{
  "user": { "operatorId": "...", "createdAt": "..." },
  "wallet": "...",
  "season": { "name": "...", "status": "ACTIVE", ... },
  "stats": { "points": 0, "rank": 0, "eventCount": 0 },
  "allTime": { "totalPoints": 0, "seasonsCount": 0, "bestRank": 0 },
  "seasonStamps": [],
  "badges": [],
  "nearbyRanks": [],
  "dailyMissions": [],
  "prizePool": {},
  "syncedAt": "...",
  "recentEvents": []
}
```

---

## Environment variables (set in Vercel dashboard + local .env)

```
BOT_TOKEN=...          # Telegram bot token
DATABASE_URL=...       # PostgreSQL connection string (Supabase, pooled)
DIRECT_URL=...         # PostgreSQL direct connection (for Prisma migrations)
```

---

## Key files quick reference

| File | Purpose |
|------|---------|
| `web/public/panel.html` | Panel SPA HTML (Miner's Passport, tabs) |
| `web/public/panel.js` | Panel SPA logic (doRefresh, state, render) |
| `web/public/panel.css` | Panel styles |
| `web/app/api/panel/me/route.ts` | Panel data API (App Router) |
| `web/app/api/panel/leaderboard/route.ts` | Leaderboard API |
| `web/app/panel/route.ts` | Serves panel.html |
| `web/lib/webAppAuth.ts` | Telegram WebApp HMAC auth |
| `src/index.ts` | Bot entry point |
| `src/scanner/x1FactoryScanner.ts` | On-chain scanner (60s interval) |
| `src/services/pointsService.ts` | Points + Telegram notifications |
| `prisma/schema.prisma` | DB schema (User, Wallet, Season, etc.) |
| `web/next.config.mjs` | Next.js config (bs58 shim, Solana webpack) |

---

## Where we left off (2026-06-05)

- Hard reset to `4761f71` (MIND FACTORY website intact)
- Integrated bot (`src/`) on top → commit `2c2a529`
- Bot is running and scanning 1 wallet
- Vercel deploy triggered at `a842092`
- The panel at `/panel` should be working with App Router API
- Next thing to verify: x1factory.xyz/ shows MIND FACTORY app correctly, x1factory.xyz/panel shows seasons panel
