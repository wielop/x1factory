const DEFAULT_CONFIG = {
  claimRateXnt: 0.015,
  dailyTapCap: 50,
  initialTreasuryMind: 5000,
  payoutWalletLabel: "Registered season wallet",
  fundingWalletLabel: "Clicker funding wallet",
  seasonName: "Season 0",
  mode: "test",
};

function readNumberEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function GET() {
  return Response.json({
    ...DEFAULT_CONFIG,
    claimRateXnt: readNumberEnv("TELEGRAM_CLICKER_CLAIM_RATE_XNT", DEFAULT_CONFIG.claimRateXnt),
    dailyTapCap: readNumberEnv("TELEGRAM_CLICKER_DAILY_TAP_CAP", DEFAULT_CONFIG.dailyTapCap),
    initialTreasuryMind: readNumberEnv("TELEGRAM_CLICKER_INITIAL_TREASURY_MIND", DEFAULT_CONFIG.initialTreasuryMind),
  });
}
