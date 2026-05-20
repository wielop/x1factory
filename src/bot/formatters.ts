import type { LeaderboardEntry } from "../services/leaderboardService.js";

function formatRankingUser(entry: LeaderboardEntry): string {
  return entry.username === entry.telegramId.toString() ? entry.telegramId.toString() : `@${entry.username}`;
}

export function formatRanking(entries: LeaderboardEntry[]): string {
  return entries
    .map((entry) => `${entry.rank}. ${formatRankingUser(entry)} - ${entry.points} pts`)
    .join("\n");
}

export function formatDisplayName(user: {
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): string {
  if (user.username) {
    return `@${user.username}`;
  }

  return [user.firstName, user.lastName].filter(Boolean).join(" ") || "Unknown user";
}
