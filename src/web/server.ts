import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { readFile } from "node:fs/promises";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { prisma } from "../db/prisma.js";
import {
  cancelPendingClaim,
  createClaimCheckout,
  formatClickerMicroAmount,
  getClickerDashboard,
  runFactoryTap,
  upgradeClickerModule
} from "../services/clickerService.js";
import {
  buyHashRushBoost,
  buyHashRushUpgrade,
  collectHashRush,
  getHashRushDashboard,
  getHashRushLeaderboard,
  mineHashRush
} from "../services/hashRushService.js";
import { parseTelegramWebAppAuth } from "./webAppAuth.js";

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
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return value ?? "";
}

function toTelegramPayload(auth: NonNullable<ReturnType<typeof parseTelegramWebAppAuth>>["user"]) {
  return {
    id: auth.id,
    username: auth.username,
    first_name: auth.first_name,
    last_name: auth.last_name,
    language_code: auth.language_code
  };
}

function serializeDashboard(dashboard: Awaited<ReturnType<typeof getClickerDashboard>>) {
  return {
    user: {
      telegramId: dashboard.user.telegramId.toString(),
      username: dashboard.user.username,
      firstName: dashboard.user.firstName,
      lastName: dashboard.user.lastName
    },
    payoutWallet: dashboard.payoutWallet
      ? {
          address: dashboard.payoutWallet.address,
          shortAddress:
            dashboard.payoutWallet.address.length > 12
              ? `${dashboard.payoutWallet.address.slice(0, 4)}...${dashboard.payoutWallet.address.slice(-4)}`
              : dashboard.payoutWallet.address
      }
      : null,
    clickerWallet: dashboard.clickerWallet
      ? {
          address: dashboard.clickerWallet.address,
          shortAddress:
            dashboard.clickerWallet.address.length > 12
              ? `${dashboard.clickerWallet.address.slice(0, 4)}...${dashboard.clickerWallet.address.slice(-4)}`
              : dashboard.clickerWallet.address
        }
      : null,
    seasonName: dashboard.seasonName,
    dailyTapCap: dashboard.dailyTapCap,
    tapsLeft: dashboard.tapsLeft,
    claimableMind: formatClickerMicroAmount(dashboard.claimableMindMicro),
    claimableMindMicro: dashboard.claimableMindMicro.toString(),
    referenceXntPerMind: formatClickerMicroAmount(dashboard.referenceXntPerMindMicro),
    claimPricePerMind: formatClickerMicroAmount(dashboard.claimPricePerMindMicro),
    tapRewardMind: formatClickerMicroAmount(dashboard.tapRewardMindMicro),
    operatorLevel: dashboard.operatorLevel,
    reactorCoreLevel: dashboard.reactorCoreLevel,
    fuelCellLevel: dashboard.fuelCellLevel,
    claimTerminalLevel: dashboard.claimTerminalLevel,
    stabilityModuleLevel: dashboard.stabilityModuleLevel,
    streakDays: dashboard.streakDays,
    nextReactorCostMind: formatClickerMicroAmount(dashboard.nextReactorCostMind),
    nextFuelCostMind: formatClickerMicroAmount(dashboard.nextFuelCostMind),
    nextClaimCostMind: formatClickerMicroAmount(dashboard.nextClaimCostMind),
    nextStabilityCostMind: formatClickerMicroAmount(dashboard.nextStabilityCostMind),
    currentBoost: dashboard.currentBoost,
    boostExpiresAt: dashboard.boostExpiresAt ? dashboard.boostExpiresAt.toISOString() : null,
    treasury: {
      mindReserveFloor: formatClickerMicroAmount(dashboard.treasury.mindReserveFloorMicro),
      mindTreasuryBalance: formatClickerMicroAmount(dashboard.treasury.mindTreasuryBalanceMicro),
      xntTreasuryBalance: formatClickerMicroAmount(dashboard.treasury.xntTreasuryBalanceMicro),
      rate: formatClickerMicroAmount(dashboard.treasury.xntPerMindMicro),
      minimumClaimMind: formatClickerMicroAmount(dashboard.treasury.minimumClaimMindMicro),
      claimPaused: dashboard.treasury.claimPaused
    },
    pendingClaim: dashboard.pendingClaim
      ? {
          id: dashboard.pendingClaim.id,
          claimableMind: formatClickerMicroAmount(dashboard.pendingClaim.claimableMindMicro),
          claimableMindMicro: dashboard.pendingClaim.claimableMindMicro.toString(),
          xntRequired: formatClickerMicroAmount(dashboard.pendingClaim.xntRequiredMicro),
          xntRequiredMicro: dashboard.pendingClaim.xntRequiredMicro.toString(),
          paymentStatus: dashboard.pendingClaim.paymentStatus,
          expiresAt: dashboard.pendingClaim.expiresAt.toISOString()
        }
      : null,
    todaySession: dashboard.todaySession
      ? {
          tapsUsed: dashboard.todaySession.tapsUsed,
          mindEarned: formatClickerMicroAmount(dashboard.todaySession.mindEarnedMicro),
          xntSpent: formatClickerMicroAmount(dashboard.todaySession.xntSpentMicro),
          status: dashboard.todaySession.status
        }
      : null
  };
}

function getSeasonDay(season: { startsAt: Date; endsAt: Date }): { day: number; durationDays: number; timeLeftMs: number } {
  const now = Date.now();
  const durationDays = Math.max(1, Math.ceil((season.endsAt.getTime() - season.startsAt.getTime()) / (24 * 60 * 60 * 1000)));
  const day = Math.max(1, Math.min(durationDays, Math.floor((now - season.startsAt.getTime()) / (24 * 60 * 60 * 1000) + 1)));
  return {
    day,
    durationDays,
    timeLeftMs: Math.max(0, season.endsAt.getTime() - now)
  };
}

async function serializeReactorDashboard(dashboard: Awaited<ReturnType<typeof getHashRushDashboard>>) {
  const seasonClock = getSeasonDay(dashboard.season);
  const wallet = dashboard.user.activeWalletId
    ? await prisma.wallet.findUnique({
        where: { id: dashboard.user.activeWalletId },
        select: { address: true }
      })
    : null;

  const deposits = await prisma.reactorEnergyDeposit.findMany({
    where: {
      userId: dashboard.user.id,
      seasonId: dashboard.season.id
    },
    orderBy: { createdAt: "desc" },
    take: 5
  });

  const topTen = await prisma.userSeasonStats.findMany({
    where: { seasonId: dashboard.season.id },
    orderBy: [{ rank: "asc" }, { totalPoints: "desc" }],
    take: 10
  });
  const tenthPlacePoints = topTen.length >= 10 ? topTen[9]?.totalPoints ?? 0 : 0;

  return {
    mode: "live",
    user: {
      telegramId: dashboard.user.telegramId.toString(),
      username: dashboard.user.username,
      firstName: dashboard.user.firstName
    },
    season: {
      id: dashboard.season.id,
      name: dashboard.season.name,
      status: dashboard.season.status,
      day: seasonClock.day,
      durationDays: Math.min(21, seasonClock.durationDays),
      timeLeftMs: seasonClock.timeLeftMs,
      breakDays: 7
    },
    profile: {
      hash: dashboard.profile.hashPoints.toString(),
      totalHash: dashboard.profile.totalHashPoints.toString(),
      energy: dashboard.profile.energy,
      energyCap: dashboard.profile.energyCap,
      hashPerTap: dashboard.profile.hashPerClick,
      passiveHashPerHour: dashboard.effectivePassiveHashPerHour,
      storageHours: dashboard.effectiveStorageHours,
      dailyClicks: dashboard.profile.dailyClicks,
      dailyClickCap: 500,
      factoryLevel: dashboard.profile.factoryLevel,
      rank: dashboard.rank,
      seasonPoints: dashboard.totalSeasonPoints,
      top10Distance: Math.max(0, tenthPlacePoints - dashboard.totalSeasonPoints)
    },
    wallet: {
      registered: Boolean(wallet),
      address: wallet?.address ?? null,
      reactorEnergy: dashboard.energyBalance.balance,
      totalEnergyEarned: dashboard.energyBalance.totalEarned,
      totalEnergySpent: dashboard.energyBalance.totalSpent,
      ratePerXnt: env.reactorEnergyRatePerXnt,
      minDepositXnt: env.xntDepositMinAmount,
      treasuryAddress: env.xntDepositTreasuryWallet ?? null,
      deposits: deposits.map((deposit) => ({
        txHash: deposit.txHash,
        amountXnt: deposit.amountXnt.toString(),
        energyAmount: deposit.energyAmount,
        status: deposit.status,
        createdAt: deposit.createdAt.toISOString()
      }))
    },
    boosts: dashboard.activeBoosts.map((boost) => ({
      type: boost.boostType,
      multiplier: boost.multiplier,
      expiresAt: boost.expiresAt.toISOString()
    })),
    recent: ["Reactor online", "Server-side state active", "Mock UI helpers enabled"]
  };
}

async function readStaticFile(pathname: string): Promise<Buffer | null> {
  const normalized = pathname === "/" ? "/index.html" : pathname;
  const cleanPath = normalized.replace(/^\//, "");
  const filePath = resolve(WEB_ROOT, cleanPath);

  if (!filePath.startsWith(WEB_ROOT)) {
    return null;
  }

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
    writeJson(res, 401, {
      ok: false,
      error: "Invalid or missing Telegram Web App auth data."
    });
    return;
  }

  const telegramUser = toTelegramPayload(auth.user);
  const url = new URL(req.url ?? "/", "http://localhost");
  const readBody = async (): Promise<JsonRecord> => {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }

    if (chunks.length === 0) {
      return {};
    }

    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRecord;
    } catch {
      return {};
    }
  };

  try {
    if (req.method === "GET" && url.pathname === "/api/reactor/me") {
      const dashboard = await getHashRushDashboard(telegramUser);
      writeJson(res, 200, { ok: true, game: await serializeReactorDashboard(dashboard) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reactor/tap") {
      const result = await mineHashRush(telegramUser);
      writeJson(res, 200, {
        ok: true,
        message: result.message,
        seasonPointsAwarded: result.seasonPointsAwarded ?? 0,
        game: await serializeReactorDashboard(result)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reactor/collect") {
      const result = await collectHashRush(telegramUser);
      writeJson(res, 200, {
        ok: true,
        message: result.message,
        seasonPointsAwarded: result.seasonPointsAwarded ?? 0,
        game: await serializeReactorDashboard(result)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reactor/upgrade") {
      const body = await readBody();
      const upgradeId = typeof body.upgradeId === "string" ? body.upgradeId : "";
      const result = await buyHashRushUpgrade(telegramUser, upgradeId);
      writeJson(res, 200, {
        ok: true,
        message: result.message,
        seasonPointsAwarded: result.seasonPointsAwarded ?? 0,
        game: await serializeReactorDashboard(result)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reactor/boost") {
      const body = await readBody();
      const boostId = typeof body.boostId === "string" ? body.boostId : "";
      const result = await buyHashRushBoost(telegramUser, boostId);
      writeJson(res, 200, {
        ok: true,
        message: result.message,
        game: await serializeReactorDashboard(result)
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/reactor/leaderboard") {
      const type = url.searchParams.get("type") ?? "main";
      const leaderboard = await getHashRushLeaderboard(20);
      writeJson(res, 200, {
        ok: true,
        type,
        season: {
          id: leaderboard.season.id,
          name: leaderboard.season.name
        },
        rows: leaderboard.profiles.map((profile, index) => ({
          rank: index + 1,
          username: profile.user.username,
          telegramId: profile.user.telegramId.toString(),
          hash: profile.totalHashPoints.toString(),
          dailyClicks: profile.dailyClicks,
          factoryLevel: profile.factoryLevel
        }))
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/reactor/wallet") {
      const dashboard = await getHashRushDashboard(telegramUser);
      const game = await serializeReactorDashboard(dashboard);
      writeJson(res, 200, { ok: true, wallet: game.wallet });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reactor/deposits/refresh") {
      const dashboard = await getHashRushDashboard(telegramUser);
      const game = await serializeReactorDashboard(dashboard);
      writeJson(res, 200, {
        ok: true,
        message: "Deposit scanner placeholder refreshed.",
        wallet: game.wallet
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/clicker") {
      const dashboard = await getClickerDashboard(telegramUser);
      writeJson(res, 200, { ok: true, dashboard: serializeDashboard(dashboard) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/tap") {
      const result = await runFactoryTap(telegramUser);
      writeJson(res, 200, {
        ok: true,
        message: result.message,
        dashboard: serializeDashboard(result)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/claim") {
      const result = await createClaimCheckout(telegramUser);
      writeJson(res, 200, {
        ok: true,
        message: result.message,
        dashboard: serializeDashboard(result)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/cancel") {
      const result = await cancelPendingClaim(telegramUser);
      writeJson(res, 200, {
        ok: true,
        message: result.message,
        dashboard: serializeDashboard(result)
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/upgrade") {
      const body = await readBody();
      const module = body.module;
      if (module !== "reactor" && module !== "fuel" && module !== "claim" && module !== "stability") {
        writeJson(res, 400, {
          ok: false,
          error: "Invalid upgrade module"
        });
        return;
      }

      const result = await upgradeClickerModule({
        telegramUser,
        module
      });
      writeJson(res, 200, {
        ok: true,
        message: result.message,
        dashboard: serializeDashboard(result)
      });
      return;
    }

    writeJson(res, 404, {
      ok: false,
      error: "Not found"
    });
  } catch (error) {
    logger.warn({ error, pathname: url.pathname }, "Mini app API error");
    const message = error instanceof Error ? error.message : "Request failed";
    const walletRequired = message.toLowerCase().includes("register your wallet");
    writeJson(res, walletRequired ? 403 : 400, {
      ok: false,
      code: walletRequired ? "WALLET_REQUIRED" : "REQUEST_FAILED",
      error: message
    });
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res);
    return;
  }

  if (url.pathname === "/telegrambot" || url.pathname === "/reactor") {
    const file = await readFile(resolve(WEB_ROOT, "reactor.html"));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(file);
    return;
  }

  const file = await readStaticFile(url.pathname);

  if (!file) {
    res.writeHead(404, {
      "content-type": "text/plain; charset=utf-8"
    });
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

  return () => {
    server.close();
  };
}

if (process.argv[1] && (process.argv[1].endsWith("server.ts") || process.argv[1].endsWith("server.js"))) {
  startMiniAppServer();
}
