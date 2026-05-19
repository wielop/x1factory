"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";

const DEFAULT_CLAIM_RATE_XNT = 0.015;
const DEFAULT_DAILY_TAP_CAP = 50;
const DEFAULT_INITIAL_TREASURY_MIND = 5000;
const PAYOUT_WALLET = "Registered season wallet";
const FUNDING_WALLET = "Clicker funding wallet";
const STORAGE_KEY = "x1factory.telegrambot.clicker.v1";

type ClickerConfig = {
  claimRateXnt: number;
  dailyTapCap: number;
  initialTreasuryMind: number;
  payoutWalletLabel: string;
  fundingWalletLabel: string;
  seasonName: string;
  mode: string;
};

type ClickerState = {
  tapCount: number;
  claimableMind: number;
  seasonMind: number;
  lastAction: string;
  claimStatus: "none" | "pending" | "ready";
  feed: string[];
};

function formatMind(value: number) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: value >= 1 ? 2 : 4,
    maximumFractionDigits: 4,
  });
}

function formatXnt(value: number) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

export function TelegramBotPanel() {
  const [config, setConfig] = useState<ClickerConfig>({
    claimRateXnt: DEFAULT_CLAIM_RATE_XNT,
    dailyTapCap: DEFAULT_DAILY_TAP_CAP,
    initialTreasuryMind: DEFAULT_INITIAL_TREASURY_MIND,
    payoutWalletLabel: PAYOUT_WALLET,
    fundingWalletLabel: FUNDING_WALLET,
    seasonName: "Season 0",
    mode: "test",
  });
  const [tapCount, setTapCount] = useState(0);
  const [claimableMind, setClaimableMind] = useState(0.04);
  const [seasonMind, setSeasonMind] = useState(0.04);
  const [lastAction, setLastAction] = useState("Factory booted.");
  const [claimStatus, setClaimStatus] = useState<"none" | "pending" | "ready">("none");
  const [feed, setFeed] = useState<string[]>([
    "Season 0 is live in test mode.",
    "Factory wallet and payout wallet are split.",
    "Telegram UI is running inside a mini app shell.",
  ]);
  const webAppRef = useRef<any>(null);

  useEffect(() => {
    const webApp = (window as Window & { Telegram?: { WebApp?: any } }).Telegram?.WebApp;
    if (!webApp) return;

    webAppRef.current = webApp;
    webApp.ready?.();
    webApp.expand?.();
    webApp.setHeaderColor?.("#03060a");
    webApp.setBackgroundColor?.("#03060a");
    webApp.MainButton?.show?.();
    webApp.BackButton?.show?.();
    const onMainButtonClick = () => {
      if (claimStatus === "pending") {
        confirmClaim();
        return;
      }
      runFactory();
    };

    webApp.MainButton?.onClick?.(onMainButtonClick);
    return () => {
      webApp.MainButton?.offClick?.(onMainButtonClick);
    };
  }, [claimStatus]);

  useEffect(() => {
    fetch("/api/telegrambot/config")
      .then((response) => response.json())
      .then((payload: ClickerConfig) => {
        if (!payload) return;
        setConfig({
          claimRateXnt: payload.claimRateXnt ?? DEFAULT_CLAIM_RATE_XNT,
          dailyTapCap: payload.dailyTapCap ?? DEFAULT_DAILY_TAP_CAP,
          initialTreasuryMind: payload.initialTreasuryMind ?? DEFAULT_INITIAL_TREASURY_MIND,
          payoutWalletLabel: payload.payoutWalletLabel ?? PAYOUT_WALLET,
          fundingWalletLabel: payload.fundingWalletLabel ?? FUNDING_WALLET,
          seasonName: payload.seasonName ?? "Season 0",
          mode: payload.mode ?? "test",
        });
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    try {
      const payload: ClickerState = {
        tapCount,
        claimableMind,
        seasonMind,
        lastAction,
        claimStatus,
        feed,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore local persistence failures
    }
  }, [claimStatus, claimableMind, feed, lastAction, seasonMind, tapCount]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<ClickerState>;
      if (typeof parsed.tapCount === "number") setTapCount(parsed.tapCount);
      if (typeof parsed.claimableMind === "number") setClaimableMind(parsed.claimableMind);
      if (typeof parsed.seasonMind === "number") setSeasonMind(parsed.seasonMind);
      if (typeof parsed.lastAction === "string") setLastAction(parsed.lastAction);
      if (parsed.claimStatus === "none" || parsed.claimStatus === "pending" || parsed.claimStatus === "ready") {
        setClaimStatus(parsed.claimStatus);
      }
      if (Array.isArray(parsed.feed)) setFeed(parsed.feed.filter((value): value is string => typeof value === "string"));
    } catch {
      // ignore malformed cache
    }
  }, []);

  const claimCostXnt = useMemo(() => claimableMind * config.claimRateXnt, [claimableMind, config.claimRateXnt]);

  const pushFeed = (line: string) => {
    setFeed((current) => [line, ...current].slice(0, 5));
  };

  const runFactory = () => {
    if (tapCount >= config.dailyTapCap) {
      setLastAction("Daily tap cap reached.");
      pushFeed("Daily cap reached. Come back tomorrow.");
      return;
    }

    setTapCount((current) => current + 1);
    setClaimableMind((current) => Number((current + 0.0012).toFixed(4)));
    setSeasonMind((current) => Number((current + 0.0012).toFixed(4)));
    setLastAction("Factory output increased.");
    setClaimStatus("none");
    pushFeed("Run Factory logged: +0.0012 MIND claimable.");
  };

  const beginClaim = () => {
    setClaimStatus("pending");
    setLastAction(`Claim ready at ${formatXnt(claimCostXnt)} XNT.`);
    pushFeed(`Claim opened: ${formatMind(claimableMind)} MIND for ${formatXnt(claimCostXnt)} XNT.`);
  };

  const confirmClaim = () => {
    if (claimableMind <= 0) {
      setLastAction("Nothing to claim.");
      pushFeed("Claim blocked: no MIND available.");
      return;
    }

    setClaimStatus("ready");
    setLastAction("Claim marked ready for settlement.");
    pushFeed("Claim marked ready. MIND goes to the registered season wallet.");
  };

  const cancelClaim = () => {
    setClaimStatus("none");
    setLastAction("Claim cancelled.");
    pushFeed("Claim cancelled by operator.");
  };

  useEffect(() => {
    const webApp = webAppRef.current;
    if (!webApp?.MainButton) return;
    const label = claimStatus === "pending" ? "Confirm Claim" : "Run Factory";
    webApp.MainButton.setText?.(label);
    if (claimStatus === "ready") {
      webApp.MainButton.hide?.();
    } else {
      webApp.MainButton.show?.();
    }
  }, [claimStatus]);

  return (
    <main className="min-h-screen bg-[#03060a] px-4 py-6 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-3rem)] w-full max-w-6xl flex-col gap-4">
        <Card className="border-cyan-400/15 bg-[#081018]/90">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-2">
              <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-300/80">MIND FACTORY // TELEGRAMBOT</p>
              <h1 className="text-2xl font-semibold text-white sm:text-3xl">Factory Clicker</h1>
              <p className="max-w-2xl text-sm leading-6 text-zinc-300">
                Tap the factory, build claimable MIND, then settle to the season wallet registered at the start of the season.
                The clicker wallet is separate and used only as funding.
              </p>
            </div>

            <div className="grid gap-2 text-xs text-zinc-300 sm:grid-cols-2 lg:min-w-[280px]">
              <div className="rounded-2xl border border-cyan-400/10 bg-white/5 p-3">
                <div className="text-zinc-400">Payout wallet</div>
                <div className="mt-1 font-mono text-sm text-white">{config.payoutWalletLabel}</div>
              </div>
              <div className="rounded-2xl border border-cyan-400/10 bg-white/5 p-3">
                <div className="text-zinc-400">Funding wallet</div>
                <div className="mt-1 font-mono text-sm text-white">{config.fundingWalletLabel}</div>
              </div>
            </div>
          </div>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[1.45fr_0.95fr]">
          <div className="space-y-4">
            <Card>
              <CardHeader
                title="Factory status"
                description="The mini app is live inside Telegram-style frame. This is the route Vercel should serve."
              />

              <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-2xl border border-cyan-400/10 bg-white/5 p-4">
                  <div className="text-xs uppercase tracking-wide text-zinc-400">Claimable MIND</div>
                  <div className="mt-2 text-3xl font-semibold text-white">{formatMind(claimableMind)}</div>
                </div>
                <div className="rounded-2xl border border-cyan-400/10 bg-white/5 p-4">
                  <div className="text-xs uppercase tracking-wide text-zinc-400">Season output</div>
                  <div className="mt-2 text-3xl font-semibold text-white">{formatMind(seasonMind)}</div>
                </div>
                <div className="rounded-2xl border border-cyan-400/10 bg-white/5 p-4">
                  <div className="text-xs uppercase tracking-wide text-zinc-400">Taps today</div>
                  <div className="mt-2 text-3xl font-semibold text-white">
                    {tapCount}/{config.dailyTapCap}
                  </div>
                </div>
                <div className="rounded-2xl border border-cyan-400/10 bg-white/5 p-4">
                  <div className="text-xs uppercase tracking-wide text-zinc-400">Claim rate</div>
                  <div className="mt-2 text-3xl font-semibold text-white">{formatXnt(config.claimRateXnt)}</div>
                </div>
              </div>

              <div className="mt-5">
                <div className="mb-2 flex items-center justify-between text-xs text-zinc-400">
                  <span>Daily progress</span>
                  <span>{Math.round((tapCount / config.dailyTapCap) * 100)}%</span>
                </div>
                <div className="h-2 rounded-full bg-white/5">
                  <div
                    className="h-2 rounded-full bg-gradient-to-r from-cyan-400 via-teal-300 to-emerald-300"
                    style={{ width: `${Math.min(100, (tapCount / config.dailyTapCap) * 100)}%` }}
                  />
                </div>
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Controls"
                description="This is the Telegram Mini App shell. Buttons below are ready for backend wiring."
              />

              <div className="mt-5 grid gap-3 md:grid-cols-3">
                <Button size="lg" onClick={runFactory} className="w-full">
                  Run Factory
                </Button>
                <Button size="lg" variant="secondary" onClick={beginClaim} className="w-full">
                  Claim MIND
                </Button>
                <Button size="lg" variant="ghost" onClick={cancelClaim} className="w-full">
                  Cancel Claim
                </Button>
              </div>

              <div className="mt-4 rounded-2xl border border-cyan-400/10 bg-white/5 p-4 text-sm text-zinc-300">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-zinc-500">Last action:</span>
                  <span className="text-white">{lastAction}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-zinc-500">Claim status:</span>
                  <span className="font-medium text-cyan-300">{claimStatus}</span>
                  <span className="text-zinc-500">Estimated fee:</span>
                  <span className="font-medium text-white">{formatXnt(claimCostXnt)} XNT</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-zinc-500">Treasury reserve:</span>
                  <span className="font-medium text-white">{config.initialTreasuryMind.toLocaleString("en-US")} MIND</span>
                </div>
              </div>
            </Card>
          </div>

          <div className="space-y-4">
            <Card>
              <CardHeader
                title="Live feed"
                description="Short, readable updates for the operator."
              />
              <div className="mt-4 space-y-3">
                {feed.map((line, index) => (
                  <div key={`${line}-${index}`} className="rounded-2xl border border-white/5 bg-white/5 p-3 text-sm text-zinc-300">
                    {line}
                  </div>
                ))}
              </div>
            </Card>

            <Card>
              <CardHeader
                title="Season wiring"
                description="What the bot should know once the backend is connected."
              />
              <div className="mt-4 space-y-2 text-sm text-zinc-300">
                <div className="flex items-center justify-between rounded-2xl border border-white/5 bg-white/5 px-3 py-2">
                  <span>Claim wallet</span>
                  <span className="font-mono text-zinc-100">{config.payoutWalletLabel}</span>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-white/5 bg-white/5 px-3 py-2">
                  <span>Funding wallet</span>
                  <span className="font-mono text-zinc-100">{config.fundingWalletLabel}</span>
                </div>
                <div className="rounded-2xl border border-white/5 bg-white/5 px-3 py-2 text-zinc-400">
                  MIND payouts should go to the wallet registered at season start. The clicker wallet only funds claims.
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </main>
  );
}
