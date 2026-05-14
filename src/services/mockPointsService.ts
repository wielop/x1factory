import { findAllTimeEntryByTelegramId, findSeasonEntryByTelegramId } from "./leaderboardService.js";

function pseudoNumber(seed: bigint, modulo: number, offset = 0): number {
  return Number(seed % BigInt(modulo)) + offset;
}

export function getMockProfileStats(telegramId: bigint) {
  const seasonEntry = findSeasonEntryByTelegramId(telegramId);
  const allTimeEntry = findAllTimeEntryByTelegramId(telegramId);

  if (seasonEntry || allTimeEntry) {
    return {
      currentSeasonPoints: seasonEntry?.points ?? 0,
      currentRank: seasonEntry?.rank ?? null,
      allTimePoints: allTimeEntry?.points ?? seasonEntry?.points ?? 0,
      badges: ["Early Miner", "Season Builder"].slice(0, seasonEntry ? 2 : 1),
      recentEvents: ["Wallet registered", "Joined current season"]
    };
  }

  return {
    currentSeasonPoints: pseudoNumber(telegramId, 220, 15),
    currentRank: pseudoNumber(telegramId, 200, 1),
    allTimePoints: pseudoNumber(telegramId, 900, 100),
    badges: pseudoNumber(telegramId, 2) === 0 ? ["Early Miner"] : ["Season Explorer"],
    recentEvents: ["Starter rig purchase", "Daily activity bonus", "MIND claim"].slice(
      0,
      pseudoNumber(telegramId, 3, 1)
    )
  };
}
