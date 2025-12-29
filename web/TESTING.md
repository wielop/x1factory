## E2E (Playwright) on testnet

### Prereqs
- Install deps in `web/`: `yarn install`
- Install browsers once: `npx playwright install`

### Run the app against testnet
```bash
cd web
NEXT_PUBLIC_RPC_URL=https://rpc.testnet.x1.xyz \\
NEXT_PUBLIC_PROGRAM_ID=uaDkkJGLLEY3kFMhhvrh5MZJ6fmwCmhNf8L7BZQJ9Aw \\
yarn dev
```

### Run the E2E suite
```bash
cd web
E2E_WALLET=<WALLET_PUBKEY> \\
PLAYWRIGHT_BASE_URL=http://localhost:3000 \\
yarn test:e2e
```

### Notes
- Append `?view=<WALLET_PUBKEY>` to the URL to view a wallet in read-only mode.
- `E2E_WALLET` is used by tests to compute on-chain expectations.
