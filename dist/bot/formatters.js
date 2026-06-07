function formatRankingUser(entry) {
    return entry.username === entry.telegramId.toString() ? entry.telegramId.toString() : `@${entry.username}`;
}
export function formatRanking(entries) {
    return entries
        .map((entry) => `${entry.rank}. ${formatRankingUser(entry)} - ${entry.points} pts`)
        .join("\n");
}
export function formatDisplayName(user) {
    if (user.username) {
        return `@${user.username}`;
    }
    return [user.firstName, user.lastName].filter(Boolean).join(" ") || "Unknown user";
}
