import type { RankingEntry } from "../services/mockData.js";

export function formatRanking(entries: RankingEntry[]): string {
  return entries
    .map((entry) => `${entry.rank}. @${entry.username} — ${entry.points} pts, ${entry.wins} wins`)
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
