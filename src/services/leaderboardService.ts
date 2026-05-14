import { allTimeLeaderboard, seasonLeaderboard } from "./mockData.js";

export function getSeasonLeaderboard(limit = 8) {
  return seasonLeaderboard.slice(0, limit);
}

export function getAllTimeLeaderboard(limit = 8) {
  return allTimeLeaderboard.slice(0, limit);
}

export function findSeasonEntryByTelegramId(telegramId: bigint) {
  return seasonLeaderboard.find((entry) => entry.telegramId === telegramId) ?? null;
}

export function findAllTimeEntryByTelegramId(telegramId: bigint) {
  return allTimeLeaderboard.find((entry) => entry.telegramId === telegramId) ?? null;
}
