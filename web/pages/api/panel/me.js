import { parseTelegramAuth } from '../../../lib/telegramAuth.js';
import prisma from '../../../lib/prisma.js';

function formatEventCategory(category) {
  const map = {
    wallet_registration: 'Wallet Registration',
    starter_rig_purchase: 'Starter Rig Purchase',
    pro_rig_purchase: 'Pro Rig Purchase',
    industrial_rig_purchase: 'Industrial Rig Purchase',
    starter_renewal: 'Starter Renewal',
    pro_renewal: 'Pro Renewal',
    industrial_renewal: 'Industrial Renewal',
    daily_active_starter: 'Daily Active Starter',
    daily_active_pro: 'Daily Active Pro',
    daily_active_industrial: 'Daily Active Industrial',
    claim_mind_daily: 'MIND Claim',
    stake_snapshot: 'Staking',
    daily_checkin: 'Daily Check-in',
    manual_admin_correction: 'Admin Adjustment',
  };
  return map[category] ?? category;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const initData = req.headers['x-telegram-init-data'] ?? '';
  const botToken = process.env.BOT_TOKEN ?? '';
  const tgUser = parseTelegramAuth(initData, botToken);

  if (!tgUser) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    const user = await prisma.user.upsert({
      where: { telegramId: BigInt(tgUser.id) },
      create: {
        telegramId: BigInt(tgUser.id),
        username: tgUser.username ?? null,
        firstName: tgUser.first_name ?? null,
        lastName: tgUser.last_name ?? null,
        languageCode: tgUser.language_code ?? null,
      },
      update: {
        username: tgUser.username ?? null,
        firstName: tgUser.first_name ?? null,
        lastName: tgUser.last_name ?? null,
      },
    });

    const now = Date.now();

    const [season, wallet] = await Promise.all([
      prisma.season.findFirst({
        where: { status: { in: ['ACTIVE', 'UPCOMING'] } },
        orderBy: { startsAt: 'asc' },
      }),
      prisma.wallet.findFirst({ where: { userId: user.id, isActive: true } }),
    ]);

    const stats = season
      ? await prisma.userSeasonStats.findUnique({
          where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
        })
      : null;

    const recentPoints = season
      ? await prisma.seasonPoint.findMany({
          where: { userId: user.id, seasonId: season.id },
          orderBy: { createdAt: 'desc' },
          take: 10,
        })
      : [];

    const totalDays = season
      ? Math.max(1, Math.ceil((new Date(season.endsAt) - new Date(season.startsAt)) / 86400000))
      : 21;

    const day = season
      ? Math.max(1, Math.min(totalDays, Math.floor((now - new Date(season.startsAt).getTime()) / 86400000) + 1))
      : 1;

    return res.status(200).json({
      ok: true,
      user: {
        telegramId: user.telegramId.toString(),
        username: user.username,
        firstName: user.firstName,
      },
      wallet: wallet ? { address: wallet.address } : null,
      season: season
        ? {
            id: season.id,
            name: season.name,
            status: season.status,
            startsAt: season.startsAt.toISOString(),
            endsAt: season.endsAt.toISOString(),
            day,
            totalDays,
            timeLeftMs: Math.max(0, new Date(season.endsAt).getTime() - now),
          }
        : null,
      stats: stats
        ? {
            totalPoints: stats.totalPoints,
            rank: stats.rank,
            eventsCount: stats.eventsCount,
            lastEventAt: stats.lastEventAt?.toISOString() ?? null,
          }
        : null,
      recentEvents: recentPoints.map((p) => ({
        points: p.points,
        category: p.category,
        reason: formatEventCategory(p.category),
        createdAt: p.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error('panel/me error', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
