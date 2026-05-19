"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const STORAGE_KEY = "x1factory.telegrambot.reactor.v1";
const DEFAULT_CONFIG = {
  claimRateXnt: 0.015,
  dailyTapCap: 50,
  initialTreasuryMind: 5000,
  payoutWalletLabel: "Registered season wallet",
  fundingWalletLabel: "Clicker funding wallet",
  seasonName: "Season 0",
  mode: "test",
};

const REACTOR_IMAGE = "/telegrambot/reactor-core.svg";

type Config = typeof DEFAULT_CONFIG;
type ClaimStatus = "none" | "pending" | "ready";

type State = {
  tapCount: number;
  claimableMind: number;
  seasonMind: number;
  lastAction: string;
  claimStatus: ClaimStatus;
  feed: string[];
};

type Burst = { id: number; value: string; top: number; left: number };

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

export function ReactorTapPanel() {
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG);
  const [tapCount, setTapCount] = useState(0);
  const [claimableMind, setClaimableMind] = useState(0.04);
  const [seasonMind, setSeasonMind] = useState(0.04);
  const [lastAction, setLastAction] = useState("Reactors online.");
  const [claimStatus, setClaimStatus] = useState<ClaimStatus>("none");
  const [feed, setFeed] = useState<string[]>([
    "Tap the reactor core to build claimable MIND.",
    "Top up the funding wallet with XNT to release claims.",
    "Season wallet stays separate from the clicker wallet.",
  ]);
  const [pulse, setPulse] = useState(false);
  const [burst, setBurst] = useState<Burst | null>(null);
  const webAppRef = useRef<any>(null);
  const burstIdRef = useRef(0);

  useEffect(() => {
    const webApp = (window as Window & { Telegram?: { WebApp?: any } }).Telegram?.WebApp;
    if (!webApp) return;

    webAppRef.current = webApp;
    webApp.ready?.();
    webApp.expand?.();
    webApp.setHeaderColor?.("#03060a");
    webApp.setBackgroundColor?.("#03060a");
    webApp.BackButton?.show?.();
    const onBack = () => webApp.close?.();
    webApp.BackButton?.onClick?.(onBack);
    return () => {
      webApp.BackButton?.offClick?.(onBack);
      webApp.BackButton?.hide?.();
    };
  }, []);

  useEffect(() => {
    fetch("/api/telegrambot/config")
      .then((response) => response.json())
      .then((payload: Config) => {
        if (!payload) return;
        setConfig({
          claimRateXnt: payload.claimRateXnt ?? DEFAULT_CONFIG.claimRateXnt,
          dailyTapCap: payload.dailyTapCap ?? DEFAULT_CONFIG.dailyTapCap,
          initialTreasuryMind: payload.initialTreasuryMind ?? DEFAULT_CONFIG.initialTreasuryMind,
          payoutWalletLabel: payload.payoutWalletLabel ?? DEFAULT_CONFIG.payoutWalletLabel,
          fundingWalletLabel: payload.fundingWalletLabel ?? DEFAULT_CONFIG.fundingWalletLabel,
          seasonName: payload.seasonName ?? DEFAULT_CONFIG.seasonName,
          mode: payload.mode ?? DEFAULT_CONFIG.mode,
        });
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    try {
      const payload: State = { tapCount, claimableMind, seasonMind, lastAction, claimStatus, feed };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore cache write failures
    }
  }, [tapCount, claimableMind, seasonMind, lastAction, claimStatus, feed]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<State>;
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
  const dailyProgress = Math.min(100, (tapCount / config.dailyTapCap) * 100);
  const tapsLeft = Math.max(0, config.dailyTapCap - tapCount);

  const pushFeed = (line: string) => setFeed((current) => [line, ...current].slice(0, 5));

  const pushBurst = (value: string) => {
    const nextId = burstIdRef.current + 1;
    burstIdRef.current = nextId;
    setBurst({ id: nextId, value, top: 28 + Math.floor(Math.random() * 44), left: 24 + Math.floor(Math.random() * 52) });
    window.setTimeout(() => setBurst((current) => (current?.id === nextId ? null : current)), 650);
  };

  const runFactory = () => {
    if (tapCount >= config.dailyTapCap) {
      setLastAction("Daily tap cap reached.");
      pushFeed("Daily cap reached. Come back tomorrow.");
      return;
    }

    setPulse(true);
    window.setTimeout(() => setPulse(false), 180);

    setTapCount((current) => current + 1);
    setClaimableMind((current) => Number((current + 0.0012).toFixed(4)));
    setSeasonMind((current) => Number((current + 0.0012).toFixed(4)));
    setClaimStatus("none");
    setLastAction("Reactor tapped.");
    pushFeed("Reactor hit: +0.0012 MIND claimable.");
    pushBurst("+0.0012");
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

    const label = claimStatus === "pending" ? "Confirm Claim" : claimStatus === "ready" ? "Claim Ready" : "Tap Reactor";
    webApp.MainButton.setText?.(label);
    if (claimStatus === "ready") webApp.MainButton.hide?.();
    else webApp.MainButton.show?.();
  }, [claimStatus]);

  useEffect(() => {
    const webApp = webAppRef.current;
    if (!webApp?.MainButton) return;
    const onClick = () => {
      if (claimStatus === "pending") confirmClaim();
      else runFactory();
    };
    webApp.MainButton.onClick?.(onClick);
    return () => webApp.MainButton.offClick?.(onClick);
  }, [claimStatus]);

  return (
    <main className="min-h-screen bg-[#03060a] px-4 py-5 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] w-full max-w-4xl flex-col gap-4">
        <Card className="border-cyan-400/15 bg-[#081018]/90 p-4">
          <div className="flex flex-col gap-2">
            <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-300/75">MIND FACTORY // TELEGRAMBOT</p>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h1 className="text-2xl font-semibold text-white sm:text-3xl">Factory Clicker</h1>
                <p className="mt-1 max-w-2xl text-sm leading-6 text-zinc-300">
                  Tap the reactor core. Build claimable MIND. Top up the funding wallet with XNT. Claim to your registered season wallet.
                </p>
              </div>
              <div className="rounded-2xl border border-cyan-400/10 bg-white/5 px-4 py-3 text-xs text-zinc-300">
                <div className="text-zinc-500">Claim rate</div>
                <div className="mt-1 font-mono text-base text-cyan-200">{formatXnt(config.claimRateXnt)} XNT</div>
              </div>
            </div>
          </div>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[1.4fr_0.9fr]">
          <div className="space-y-4">
            <Card className="border-cyan-400/15 bg-[#061018]/90 p-4">
              <div className="flex items-center justify-between gap-3 text-xs text-zinc-400">
                <span>Season {config.seasonName}</span>
                <span>{config.mode === "test" ? "test mode" : "live mode"}</span>
              </div>

              <button
                type="button"
                onClick={runFactory}
                aria-label="Tap reactor core"
                className="group relative mt-4 block w-full overflow-hidden rounded-[2rem] border border-cyan-400/15 bg-[#03060a] p-3 shadow-[0_24px_80px_rgba(0,0,0,0.45)] outline-none transition duration-150 active:scale-[0.995]"
              >
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(34,242,255,0.16),transparent_55%)] opacity-80 transition duration-150 group-active:opacity-100" />
                <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-white/10 to-transparent opacity-70" />
                <img
                  src={REACTOR_IMAGE}
                  alt="Reactor core"
                  className={`relative z-10 w-full select-none object-cover transition duration-150 ${pulse ? "scale-[0.985] saturate-125 brightness-110" : "scale-100"}`}
                  draggable={false}
                />
                {burst ? (
                  <div
                    key={burst.id}
                    className="pointer-events-none absolute z-20 rounded-full border border-cyan-300/30 bg-cyan-300/10 px-3 py-1 text-sm font-semibold text-cyan-100 shadow-[0_0_24px_rgba(34,242,255,0.2)]"
                    style={{ top: `${burst.top}%`, left: `${burst.left}%`, transform: "translate(-50%, -50%)" }}
                  >
                    {burst.value} MIND
                  </div>
                ) : null}
                <div className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-[#03060a] via-[#03060a]/80 to-transparent p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-[0.22em] text-zinc-400">Tap reactor</div>
                      <div className="mt-1 text-lg font-semibold text-white">{formatMind(claimableMind)} claimable MIND</div>
                    </div>
                    <div className="rounded-2xl border border-cyan-400/15 bg-cyan-400/10 px-3 py-2 text-right text-xs text-cyan-100">
                      <div className="text-cyan-100/60">Taps left</div>
                      <div className="mt-1 text-base font-semibold">{tapsLeft}</div>
                    </div>
                  </div>
                </div>
              </button>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-white/5 bg-white/5 p-4">
                  <div className="text-xs uppercase tracking-wide text-zinc-500">Claimable MIND</div>
                  <div className="mt-2 text-2xl font-semibold text-white">{formatMind(claimableMind)}</div>
                </div>
                <div className="rounded-2xl border border-white/5 bg-white/5 p-4">
                  <div className="text-xs uppercase tracking-wide text-zinc-500">Season output</div>
                  <div className="mt-2 text-2xl font-semibold text-white">{formatMind(seasonMind)}</div>
                </div>
                <div className="rounded-2xl border border-white/5 bg-white/5 p-4">
                  <div className="text-xs uppercase tracking-wide text-zinc-500">Tap progress</div>
                  <div className="mt-2 text-2xl font-semibold text-white">{Math.round(dailyProgress)}%</div>
                </div>
              </div>

              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between text-xs text-zinc-500">
                  <span>Daily line</span>
                  <span>{tapCount}/{config.dailyTapCap}</span>
                </div>
                <div className="h-2 rounded-full bg-white/5">
                  <div className="h-2 rounded-full bg-gradient-to-r from-cyan-400 via-teal-300 to-emerald-300" style={{ width: `${dailyProgress}%` }} />
                </div>
              </div>
            </Card>

            <Card className="border-cyan-400/15 bg-[#081018]/90 p-4">
              <div className="grid gap-3 md:grid-cols-3">
                <Button size="lg" onClick={beginClaim} className="w-full">Claim MIND</Button>
                <Button size="lg" variant="secondary" onClick={cancelClaim} className="w-full">Cancel Claim</Button>
                <Button size="lg" variant="ghost" onClick={() => webAppRef.current?.MainButton?.show?.()} className="w-full">Keep Playing</Button>
              </div>

              <div className="mt-4 rounded-2xl border border-cyan-400/10 bg-white/5 p-4 text-sm text-zinc-300">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-zinc-500">Status:</span>
                  <span className="text-white">{lastAction}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-zinc-500">Claim state:</span>
                  <span className="font-medium text-cyan-300">{claimStatus}</span>
                  <span className="text-zinc-500">Claim cost:</span>
                  <span className="font-medium text-white">{formatXnt(claimCostXnt)} XNT</span>
                </div>
                <div className="mt-2 text-zinc-400">
                  Top up the funding wallet to release claims. MIND still pays to the season wallet registered at the start of the season.
                </div>
              </div>
            </Card>
          </div>

          <div className="space-y-4">
            <Card className="border-cyan-400/15 bg-[#081018]/90 p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-zinc-100">Factory feed</h2>
                <span className="text-xs uppercase tracking-[0.22em] text-zinc-500">live</span>
              </div>
              <div className="mt-4 space-y-3">
                {feed.map((line, index) => (
                  <div key={`${line}-${index}`} className="rounded-2xl border border-white/5 bg-white/5 p-3 text-sm text-zinc-300">
                    {line}
                  </div>
                ))}
              </div>
            </Card>

            <Card className="border-cyan-400/15 bg-[#081018]/90 p-4">
              <h2 className="text-sm font-semibold text-zinc-100">Wiring</h2>
              <div className="mt-4 space-y-2 text-sm text-zinc-300">
                <div className="flex items-center justify-between rounded-2xl border border-white/5 bg-white/5 px-3 py-2">
                  <span>Season wallet</span>
                  <span className="font-mono text-zinc-100">{config.payoutWalletLabel}</span>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-white/5 bg-white/5 px-3 py-2">
                  <span>Funding wallet</span>
                  <span className="font-mono text-zinc-100">{config.fundingWalletLabel}</span>
                </div>
                <div className="rounded-2xl border border-white/5 bg-white/5 px-3 py-2 text-zinc-400">
                  The reactor is the tap target. Buttons below only handle claims and navigation.
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </main>
  );
}
