# mining/web

Public app (Vercel-ready) for interacting with the on-chain program:

- Public panel: `/` (create position, deposit, claim)
- Admin panel: `/admin` (admin_update_config)

## Env vars (Vercel)

- `NEXT_PUBLIC_RPC_URL` (default: `https://rpc.testnet.x1.xyz`; set to `https://rpc.mainnet.x1.xyz`/main program for x1factory)
- `NEXT_PUBLIC_PROGRAM_ID` (default: `uaDkkJGLLEY3kFMhhvrh5MZJ6fmwCmhNf8L7BZQJ9Aw`)
- `NEXT_PUBLIC_RPC_PROXY` (optional) – use `/api/rpc` for RPC CORS proxying if needed.

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
