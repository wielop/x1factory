import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { prisma } from "../db/prisma.js";
import { parseTelegramWebAppAuth } from "./webAppAuth.js";
import { upsertTelegramUser } from "../db/userRepository.js";
import { getActiveOrUpcomingSeason } from "../db/seasonRepository.js";
import { getActiveWalletForUser } from "../db/walletRepository.js";
import { formatEventCategory } from "../services/eventLabels.js";

type JsonRecord = Record<string, unknown>;

const WEB_ROOT = resolve(process.cwd(), "web");
const PORT = Number.isFinite(env.miniAppPort) && env.miniAppPort > 0 ? env.miniAppPort : 4174;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function writeJson(res: ServerResponse, statusCode: number, payload: JsonRecord): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function getHeaderValue(headers: IncomingMessage["headers"], name: string): string {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

async function readStaticFile(pathname: string): Promise<Buffer | null> {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const cleanPath = normalized.replace(/^\//, "");
  const filePath = resolve(WEB_ROOT, cleanPath);

  if (!filePath.startsWith(WEB_ROOT)) return null;

  try {
    return await readFile(filePath);
  } catch {
    if (pathname === "/" || pathname === "/index.html" || !extname(pathname)) {
      return readFile(resolve(WEB_ROOT, "index.html"));
    }
    return null;
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const initData = getHeaderValue(req.headers, "x-telegram-init-data");
  const auth = parseTelegramWebAppAuth(initData, env.botToken);

  if (!auth) {
    writeJson(res, 401, { ok: false, error: "Invalid or missing Telegram Web App auth data." });
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");

  try {
    if (req.method === "GET" && url.pathname === "/api/panel/me") {
      const user = await upsertTelegramUser({
        telegramId: BigInt(auth.user.id),
        username: auth.user.username,
        firstName: auth.user.first_name,
        lastName: auth.user.last_name,
        languageCode: auth.user.language_code
      });

      const now = Date.now();
      const [season, wallet] = await Promise.all([
        getActiveOrUpcomingSeason(),
        getActiveWalletForUser(user.id)
      ]);

      const stats = season
        ? await prisma.userSeasonStats.findUnique({
            where: { userId_seasonId: { userId: user.id, seasonId: season.id } }
          })
        : null;

      const recentPoints = season
        ? await prisma.seasonPoint.findMany({
            where: { userId: user.id, seasonId: season.id },
            orderBy: { createdAt: "desc" },
            take: 10
          })
        : [];

      const totalDays = season
        ? Math.max(1, Math.ceil((season.endsAt.getTime() - season.startsAt.getTime()) / 86400000))
        : 21;

      const day = season
        ? Math.max(1, Math.min(totalDays, Math.floor((now - season.startsAt.getTime()) / 86400000) + 1))
        : 1;

      writeJson(res, 200, {
        ok: true,
        user: {
          telegramId: user.telegramId.toString(),
          username: user.username,
          firstName: user.firstName
        },
        wallet: wallet
          ? {
              address: wallet.address,
              short: wallet.address.length > 12
                ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
                : wallet.address
            }
          : null,
        season: season
          ? {
              id: season.id,
              name: season.name,
              status: season.status,
              startsAt: season.startsAt.toISOString(),
              endsAt: season.endsAt.toISOString(),
              day,
              totalDays,
              timeLeftMs: Math.max(0, season.endsAt.getTime() - now)
            }
          : null,
        stats: stats
          ? {
              totalPoints: stats.totalPoints,
              rank: stats.rank,
              eventsCount: stats.eventsCount,
              lastEventAt: stats.lastEventAt?.toISOString() ?? null
            }
          : null,
        recentEvents: recentPoints.map(p => ({
          points: p.points,
          category: p.category,
          reason: formatEventCategory(p.category),
          createdAt: p.createdAt.toISOString()
        }))
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/panel/leaderboard") {
      const user = await upsertTelegramUser({
        telegramId: BigInt(auth.user.id),
        username: auth.user.username,
        firstName: auth.user.first_name,
        lastName: auth.user.last_name,
        languageCode: auth.user.language_code
      });

      const season = await getActiveOrUpcomingSeason();

      if (!season) {
        writeJson(res, 200, { ok: true, season: null, myRank: null, rows: [] });
        return;
      }

      const [topStats, myStats] = await Promise.all([
        prisma.userSeasonStats.findMany({
          where: { seasonId: season.id },
          orderBy: [{ rank: "asc" }, { totalPoints: "desc" }],
          take: 50,
          include: { user: true }
        }),
        prisma.userSeasonStats.findUnique({
          where: { userId_seasonId: { userId: user.id, seasonId: season.id } }
        })
      ]);

      writeJson(res, 200, {
        ok: true,
        season: { id: season.id, name: season.name },
        myRank: myStats?.rank ?? null,
        rows: topStats.map((s, i) => ({
          rank: s.rank ?? (i + 1),
          telegramId: s.user.telegramId.toString(),
          username: s.user.username,
          firstName: s.user.firstName,
          points: s.totalPoints,
          eventsCount: s.eventsCount
        }))
      });
      return;
    }

    writeJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    logger.warn({ error, pathname: url.pathname }, "Panel API error");
    const message = error instanceof Error ? error.message : "Request failed";
    writeJson(res, 400, { ok: false, error: message });
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res);
    return;
  }

  if (url.pathname === "/panel") {
    const file = await readFile(resolve(WEB_ROOT, "panel.html"));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(file);
    return;
  }

  const file = await readStaticFile(url.pathname);

  if (!file) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const normalizedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const type = MIME_TYPES[extname(normalizedPath)] ?? "application/octet-stream";

  res.writeHead(200, {
    "content-type": type,
    "cache-control": normalizedPath === "/index.html" ? "no-store" : "public, max-age=60"
  });
  res.end(file);
}

export function startMiniAppServer(port = PORT, host = env.miniAppHost ?? "127.0.0.1"): () => void {
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });

  const tryListen = (candidatePort: number, remainingAttempts: number): void => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && remainingAttempts > 0) {
        tryListen(candidatePort + 1, remainingAttempts - 1);
        return;
      }
      logger.error({ error, host: candidatePort }, "Mini app server failed to start");
      throw error;
    });

    server.listen(candidatePort, host, () => {
      logger.info({ host, port: candidatePort, webRoot: WEB_ROOT }, "Mini app server started");
    });
  };

  tryListen(port, 10);

  return () => { server.close(); };
}

if (process.argv[1] && (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"))) {
  startMiniAppServer();
}
