import { prisma } from "../db/prisma.js";
import { FACTORY_XP, factoryHeader } from "../bot/ui.js";
import { notifyTelegramUser } from "../bot/notifier.js";
import { logger } from "../config/logger.js";

// ── helpers ───────────────────────────────────────────────

function startOfUtcDay(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function getActiveSeason() {
  return prisma.season.findFirst({ where: { status: "ACTIVE" } });
}

async function getAllActiveUsers(seasonId: number) {
  return prisma.userSeasonStats.findMany({
    where: { seasonId },
    include: { user: true },
  });
}

async function checkinDoneToday(userId: number, seasonId: number): Promise<boolean> {
  const dayStart = startOfUtcDay();
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const row = await prisma.seasonPoint.findFirst({
    where: { userId, seasonId, category: "daily_checkin", createdAt: { gte: dayStart, lt: dayEnd } },
  });
  return row !== null;
}

async function claimDoneToday(userId: number, seasonId: number): Promise<boolean> {
  const dayStart = startOfUtcDay();
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const row = await prisma.seasonPoint.findFirst({
    where: { userId, seasonId, category: "claim_mind_daily", createdAt: { gte: dayStart, lt: dayEnd } },
  });
  return row !== null;
}

async function todayPoints(userId: number, seasonId: number): Promise<number> {
  const dayStart = startOfUtcDay();
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const agg = await prisma.seasonPoint.aggregate({
    where: { userId, seasonId, createdAt: { gte: dayStart, lt: dayEnd }, points: { gt: 0 } },
    _sum: { points: true },
  });
  return agg._sum.points ?? 0;
}

// ── Morning digest — 08:00 UTC ────────────────────────────

export async function sendMorningDigests(): Promise<void> {
  const season = await getActiveSeason();
  if (!season) return;

  const users = await getAllActiveUsers(season.id);
  logger.info(`[daily] sending morning digests to ${users.length} users`);

  for (const stats of users) {
    const { user } = stats;
    if (!user.telegramId) continue;

    const checkin = await checkinDoneToday(user.id, season.id);
    const claim   = await claimDoneToday(user.id, season.id);
    const streak  = stats.streakCount ?? 0;

    const MILESTONES = [3, 7, 14, 21];
    const nextMilestone = MILESTONES.find(m => m > streak);

    const lines = [
      factoryHeader("MORNING REPORT"),
      "",
      `☀️ Good morning, ${user.username ? `@${user.username}` : "Operator"}!`,
      "",
      `Season: ${season.name}`,
      `Your ${FACTORY_XP}: ${stats.totalPoints}`,
      `Rank: ${stats.rank ? `#${stats.rank}` : "unranked"}`,
      `Streak: 🔥 ${streak} day${streak !== 1 ? "s" : ""} in a row`,
      "",
      "── Today's missions ──",
      `${checkin ? "✅" : "⬜"} Daily Check-in ${checkin ? "(done)" : "(open)"}`,
      `${claim   ? "✅" : "⬜"} Claim MIND     ${claim   ? "(done)" : "(open)"}`,
    ];

    if (!checkin || !claim) {
      lines.push("", "Complete both to keep your streak going!");
    }

    if (nextMilestone) {
      const left = nextMilestone - streak;
      lines.push("", `🎯 Streak milestone: ${left} day${left !== 1 ? "s" : ""} to +${[50, 150, 350, 700][MILESTONES.indexOf(nextMilestone)]} ${FACTORY_XP} bonus`);
    }

    await notifyTelegramUser(user.telegramId, lines.join("\n")).catch(() => undefined);
  }
}

// ── Noon reminder — 12:00 UTC ─────────────────────────────

export async function sendNoonReminders(): Promise<void> {
  const season = await getActiveSeason();
  if (!season) return;

  const users = await getAllActiveUsers(season.id);
  logger.info(`[daily] sending noon reminders to ${users.length} users`);

  for (const stats of users) {
    const { user } = stats;
    if (!user.telegramId) continue;

    const checkin = await checkinDoneToday(user.id, season.id);
    const claim   = await claimDoneToday(user.id, season.id);

    // Skip users who already did everything
    if (checkin && claim) continue;

    const missing: string[] = [];
    if (!checkin) missing.push("⚡ /checkin — Daily Check-in (+10 pts)");
    if (!claim)   missing.push("💎 Claim MIND on X1Factory (+5–150 pts)");

    const lines = [
      factoryHeader("MIDDAY REMINDER"),
      "",
      "🕛 Half the day is gone — don't lose your streak!",
      "",
      "Still pending:",
      ...missing,
    ];

    if (!checkin && !claim) {
      lines.push("", "⚠️ Miss both and your streak resets to 0.");
    }

    await notifyTelegramUser(user.telegramId, lines.join("\n")).catch(() => undefined);
  }
}

// ── Evening recap — 20:00 UTC ─────────────────────────────

export async function sendEveningRecaps(): Promise<void> {
  const season = await getActiveSeason();
  if (!season) return;

  const users = await getAllActiveUsers(season.id);
  logger.info(`[daily] sending evening recaps to ${users.length} users`);

  // Top 3 for context
  const top3 = await prisma.userSeasonStats.findMany({
    where: { seasonId: season.id },
    orderBy: { rank: "asc" },
    take: 3,
    include: { user: true },
  });

  for (const stats of users) {
    const { user } = stats;
    if (!user.telegramId) continue;

    const earned  = await todayPoints(user.id, season.id);
    const checkin = await checkinDoneToday(user.id, season.id);
    const claim   = await claimDoneToday(user.id, season.id);
    const streak  = stats.streakCount ?? 0;

    const MILESTONES = [3, 7, 14, 21];
    const nextMilestone = MILESTONES.find(m => m > streak);

    const daysLeft = Math.ceil((season.endsAt.getTime() - Date.now()) / 86_400_000);

    const lines = [
      factoryHeader("EVENING RECAP"),
      "",
      `🌙 End of day summary`,
      "",
      `Today's output: +${earned} ${FACTORY_XP}`,
      `Season total:   ${stats.totalPoints} ${FACTORY_XP}`,
      `Rank:           ${stats.rank ? `#${stats.rank}` : "unranked"}`,
      `Streak:         🔥 ${streak} day${streak !== 1 ? "s" : ""}`,
    ];

    // Streak status
    if (checkin && claim) {
      lines.push("", "✅ Streak secured for today. See you tomorrow!");
    } else {
      const stillMissing: string[] = [];
      if (!checkin) stillMissing.push("check-in (/checkin)");
      if (!claim)   stillMissing.push("claim MIND on X1Factory");
      lines.push("", `⚠️ Streak at risk! Still missing: ${stillMissing.join(" & ")}`);
    }

    // Season countdown
    lines.push("", `⏳ Season ends in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}`);

    // Mini leaderboard (show only if not in top 3)
    if (stats.rank && stats.rank > 3 && top3.length > 0) {
      lines.push("", "── Top 3 ──");
      for (const t of top3) {
        const marker = t.userId === user.id ? " ← you" : "";
        const name = t.user.username ? `@${t.user.username}` : `Operator`;
        lines.push(`#${t.rank} ${name} — ${t.totalPoints} ${FACTORY_XP}${marker}`);
      }
      lines.push(`#${stats.rank} you — ${stats.totalPoints} ${FACTORY_XP}`);
    }

    // Motivational tip
    if (nextMilestone) {
      const left = nextMilestone - streak;
      lines.push("", `💡 ${left} more day${left !== 1 ? "s" : ""} to your next streak bonus!`);
    }

    await notifyTelegramUser(user.telegramId, lines.join("\n")).catch(() => undefined);
  }
}

// ── Pool funding broadcast ────────────────────────────────

export async function broadcastPoolFunded(opts: {
  poolMind: string;
  poolXnt: string;
  poolUsdCents: number;
}): Promise<void> {
  const season = await getActiveSeason();
  if (!season) return;

  const users = await getAllActiveUsers(season.id);
  logger.info(`[pool] broadcasting pool funding to ${users.length} users`);

  const usd = (opts.poolUsdCents / 100).toFixed(0);
  const lines = [
    factoryHeader("GIGA SWAP ALERT"),
    "",
    "⚡ The reward pool just got topped up!",
    "",
    `Pool MIND: ${Number(opts.poolMind).toFixed(2)} MIND`,
    `Pool XNT:  ${Number(opts.poolXnt).toFixed(2)} XNT`,
    `Total:     ~$${usd}`,
    "",
    "Every swap ≥ $5 enters GigaSwap — win up to 15× your fee",
    "plus a bonus from the live pool.",
    "",
    "👉 Swap now: x1factory.xyz/swap",
  ];

  const msg = lines.join("\n");
  for (const stats of users) {
    if (!stats.user.telegramId) continue;
    await notifyTelegramUser(stats.user.telegramId, msg).catch(() => undefined);
  }
}
