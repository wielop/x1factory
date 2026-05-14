export type SeasonSummary = {
  id: string;
  name: string;
  status: "upcoming" | "active" | "completed";
  startsAt: string;
  endsAt: string;
  prizePool: string;
  summary: string;
};

export type RankingEntry = {
  rank: number;
  telegramId: bigint;
  username: string;
  points: number;
  wins: number;
};

export const seasons: SeasonSummary[] = [
  {
    id: "s3",
    name: "Season 3",
    status: "active",
    startsAt: "2026-05-01",
    endsAt: "2026-06-30",
    prizePool: "25,000 X1",
    summary: "Builders compete for seasonal points, streaks, and leaderboard rewards."
  },
  {
    id: "s2",
    name: "Season 2",
    status: "completed",
    startsAt: "2026-03-01",
    endsAt: "2026-04-30",
    prizePool: "20,000 X1",
    summary: "The previous season introduced boosted weekend events."
  }
];

export const seasonLeaderboard: RankingEntry[] = [
  { rank: 1, telegramId: 10001n, username: "alpha_builder", points: 1840, wins: 14 },
  { rank: 2, telegramId: 10002n, username: "quant_forge", points: 1715, wins: 12 },
  { rank: 3, telegramId: 10003n, username: "satoshi_loop", points: 1660, wins: 11 },
  { rank: 4, telegramId: 10004n, username: "delta_miner", points: 1525, wins: 10 },
  { rank: 5, telegramId: 10005n, username: "gamma_ops", points: 1490, wins: 9 },
  { rank: 6, telegramId: 10006n, username: "botrunner", points: 1405, wins: 8 },
  { rank: 7, telegramId: 10007n, username: "mech_wolf", points: 1360, wins: 8 },
  { rank: 8, telegramId: 10008n, username: "vaultsmith", points: 1295, wins: 7 }
];

export const allTimeLeaderboard: RankingEntry[] = [
  { rank: 1, telegramId: 20001n, username: "alpha_builder", points: 5320, wins: 41 },
  { rank: 2, telegramId: 20002n, username: "quant_forge", points: 4885, wins: 36 },
  { rank: 3, telegramId: 20003n, username: "botrunner", points: 4710, wins: 33 },
  { rank: 4, telegramId: 20004n, username: "delta_miner", points: 4590, wins: 31 },
  { rank: 5, telegramId: 20005n, username: "vaultsmith", points: 4415, wins: 29 },
  { rank: 6, telegramId: 20006n, username: "gamma_ops", points: 4370, wins: 27 },
  { rank: 7, telegramId: 20007n, username: "satoshi_loop", points: 4290, wins: 26 },
  { rank: 8, telegramId: 20008n, username: "mech_wolf", points: 4150, wins: 24 }
];
