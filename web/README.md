# mining/web

Public app (Vercel-ready) for interacting with the on-chain program:

- Public panel: `/` (create position, deposit, claim)
- Admin panel: `/admin` (admin_update_config)
- X1Mind miner: `/miner` (commit/reveal/claim) + cron at `/api/x1mind/cron`

## Env vars (Vercel)

- `NEXT_PUBLIC_RPC_URL` (default: `https://rpc.testnet.x1.xyz`; set to `https://rpc.mainnet.x1.xyz`/main program for x1factory)
- `NEXT_PUBLIC_PROGRAM_ID` (default: `uaDkkJGLLEY3kFMhhvrh5MZJ6fmwCmhNf8L7BZQJ9Aw`)
- `NEXT_PUBLIC_X1MIND_PROGRAM_ID` (default: `7qH6rrAoNEp2oWmVurvqD9onVu1cCJcg7vLR6NigvkLz`)
- `NEXT_PUBLIC_X1MIND_MIND_MINT` (default: `AJhe17P7jFTUgsTUJYxvTdqpND5RG1cr1SSXxLrG9QUc`)
- `NEXT_PUBLIC_RPC_PROXY` (optional) – use `/api/rpc` for RPC CORS proxying if needed.
- `X1MIND_ADMIN_KEYPAIR` (server-only) – admin keypair (base58 or JSON array) used by `/api/x1mind/cron`.
- `CRON_SECRET` (server-only) – bearer token required by `/api/x1mind/cron`.

X1Mind config PDA is derived from the program id using seed `config` (default: `6JUBZXSMBRTdCjCD8tQ8CXY1hM5dxggfXuTYG9Zamhu`).

## Uniterminal data proxy

- Public GET endpoint: `/api/uniterminal?version=5` (returns Uniterminal config with CORS headers).

## Local run

```bash
cd web
yarn install
yarn dev
```

## UI redesign notes

- Visual direction: near-black base with cyan/teal glow, thin outlines, and large-number summary cards.
- Unified dashboard with tabs (Mine XNT / Stake MIND / XP) plus a quickstart wizard for first-time users.
- Secondary protocol details moved into `details` accordions to reduce clutter.
- Tailwind additions: custom `night/ink/neon/tide/pulse` colors, glow shadows, and Space Grotesk + JetBrains Mono fonts (see `tailwind.config.ts` and `app/layout.tsx`).
