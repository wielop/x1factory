import { parseTelegramAuth } from '../../../lib/telegramAuth.js';
import prisma from '../../../lib/prisma.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const initData = req.headers['x-telegram-init-data'] ?? '';
  const botToken = process.env.BOT_TOKEN ?? '';
  const tgUser = parseTelegramAuth(initData, botToken);

  if (!tgUser) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(tgUser.id) },
    });

    const season = await prisma.season.findFirst({
      where: { status: { in: ['ACTIVE', 'UPCOMING'] } },
      orderBy: { startsAt: 'asc' },
    });

    if (!season) {
      return res.status(200).json({ ok: true, season: null, myRank: null, rows: [] });
    }

    const [topStats, myStats] = await Promise.all([
      prisma.userSeasonStats.findMany({
        where: { seasonId: season.id },
        orderBy: [{ rank: 'asc' }, { totalPoints: 'desc' }],
        take: 50,
        include: { user: true },
      }),
      user
        ? prisma.userSeasonStats.findUnique({
            where: { userId_seasonId: { userId: user.id, seasonId: season.id } },
          })
        : Promise.resolve(null),
    ]);

    return res.status(200).json({
      ok: true,
      season: { id: season.id, name: season.name },
      myRank: myStats?.rank ?? null,
      rows: topStats.map((s, i) => ({
        rank: s.rank ?? i + 1,
        telegramId: s.user.telegramId.toString(),
        username: s.user.username,
        firstName: s.user.firstName,
        points: s.totalPoints,
        eventsCount: s.eventsCount,
      })),
    });
  } catch (err) {
    console.error('panel/leaderboard error', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
}
