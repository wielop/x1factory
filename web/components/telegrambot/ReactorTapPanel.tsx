"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const DEFAULT_CLAIM_RATE_XNT = 0.015;
const DEFAULT_DAILY_TAP_CAP = 50;
const DEFAULT_INITIAL_TREASURY_MIND = 5000;
const STORAGE_KEY = "x1factory.telegrambot.reactor.v1";

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
  taps: number;
  claimableMind: number;
  seasonMind: number;
  claimStatus: "none" | "pending" | "ready";
  feed: string[];
  lastAction: string;
};

type Burst = {
  id: number;
  value: string;
  top: number;
  left: number;
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

function ReactorCore({ pulse }: { pulse: boolean }) {
  return (
    <svg viewBox="0 0 960 960" className="h-full w-full" aria-hidden="true">
      <defs>
        <radialGradient id="reactorGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(480 480) scale(270)">
          <stop offset="0" stopColor="#efffff" />
          <stop offset="0.2" stopColor="#84f4ff" />
          <stop offset="0.55" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#041018" />
        </radialGradient>
        <linearGradient id="metal" x1="180" y1="160" x2="780" y2="820" gradientUnits="userSpaceOnUse">
          <stop stopColor="#2f3842" />
          <stop offset="0.5" stopColor="#141b23" />
          <stop offset="1" stopColor="#4b5662" />
        </linearGradient>
        <filter id="blur" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation={pulse ? 18 : 12} />
        </filter>
      </defs>

      <rect width="960" height="960" fill="#02060a" />
      <circle cx="480" cy="480" r="360" fill="url(#metal)" stroke="#7b8794" strokeOpacity="0.14" strokeWidth="8" />
      <circle cx="480" cy="480" r="292" fill="#0c1118" stroke="#374151" strokeWidth="10" />
      <circle cx="480" cy="480" r="226" fill="#081018" stroke="#29323a" strokeWidth="8" />
      <circle cx="480" cy="480" r="184" fill="none" stroke="#5ee7ff" strokeOpacity="0.55" strokeWidth="18" />
      <circle cx="480" cy="480" r="142" fill="none" stroke="#5ee7ff" strokeOpacity="0.8" strokeWidth="12" />
      <circle cx="480" cy="480" r="96" fill="none" stroke="#7dfcff" strokeOpacity="0.92" strokeWidth="10" />
      <g filter="url(#blur)">
        <circle cx="480" cy="480" r="120" fill="url(#reactorGlow)" />
        <circle cx="480" cy="480" r="64" fill="#d8ffff" />
        <circle cx="480" cy="480" r="24" fill="#ffffff" />
      </g>
      <g opacity="0.92">
        <rect x="452" y="182" width="56" height="116" rx="16" fill="url(#metal)" stroke="#84d8e8" strokeOpacity="0.3" />
        <rect x="452" y="662" width="56" height="116" rx="16" fill="url(#metal)" stroke="#84d8e8" strokeOpacity="0.3" />
        <rect x="182" y="452" width="116" height="56" rx="16" fill="url(#metal)" stroke="#84d8e8" strokeOpacity="0.3" />
        <rect x="662" y="452" width="116" height="56" rx="16" fill="url(#metal)" stroke="#84d8e8" strokeOpacity="0.3" />
      </g>
      <g filter="url(#blur)">
        <rect x="468" y="246" width="24" height="108" rx="10" fill="#38f5ff" />
        <rect x="468" y="606" width="24" height="108" rx="10" fill="#38f5ff" />
        <rect x="246" y="468" width="108" height="24" rx="10" fill="#38f5ff" />
        <rect x="606" y="468" width="108" height="24" rx="10" fill="#38f5ff" />
      </g>
      <path d="M480 150V220" stroke="#7b8794" strokeWidth="10" strokeLinecap="round" opacity="0.6" />
      <path d="M480 740V810" stroke="#7b8794" strokeWidth="10" strokeLinecap="round" opacity="0.6" />
      <path d="M150 480H220" stroke="#7b8794" strokeWidth="10" strokeLinecap="round" opacity="0.6" />
      <path d="M740 480H810" stroke="#7b8794" strokeWidth="10" strokeLinecap="round" opacity="0.6" />
      <path d="M330 226L374 270" stroke="#ff9f43" strokeWidth="8" strokeLinecap="round" opacity="0.5" />
      <path d="M630 690L586 646" stroke="#ff9f43" strokeWidth="8" strokeLinecap="round" opacity="0.5" />
      <path d="M692 262L648 306" stroke="#ff9f43" strokeWidth="8" strokeLinecap="round" opacity="0.5" />
      <path d="M268 698L312 654" stroke="#ff9f43" strokeWidth="8" strokeLinecap="round" opacity="0.5" />
    </svg>
  );
}

export function ReactorTapPanel() {
  const [config, setConfig] = useState<ClickerConfig>({
    claimRateXnt: DEFAULT_CLAIM_RATE_XNT,
    dailyTapCap: DEFAULT_DAILY_TAP_CAP,
    initialTreasuryMind: DEFAULT_INITIAL_TREASURY_MIND,
    payoutWalletLabel: "Registered season wallet",
    fundingWalletLabel: "Clicker funding wallet",
    seasonName: "Season 0",
    mode: "test",
  });
  const [taps, setTaps] = useState(0);
  const [claimableMind, setClaimableMind] = useState(0.04);
  const [seasonMind, setSeasonMind] = useState(0.04);
  const [claimStatus, setClaimStatus] = useState<"none" | "pending" | "ready">("none");
  const [lastAction, setLastAction] = useState("Reactor online.");
  const [feed, setFeed] = useState<string[]>([
    "Tap the reactor core to build claimable MIND.",
    "The clicker wallet funds claims. The season wallet receives payouts.",
    "Season 0 is a test line. Season 1 starts clean.",
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
    const onBackButtonClick = () => webApp.close?.();
    webApp.BackButton?.onClick?.(onBackButtonClick);
    return () => {
      webApp.BackButton?.offClick?.(onBackButtonClick);
      webApp.BackButton?.hide?.();
    };
  }, []);

  useEffect(() => {
    fetch("/api/telegrambot/config")
      .then((response) => response.json())
      .then((payload: ClickerConfig) => {
        if (!payload) return;
        setConfig({
          claimRateXnt: payload.claimRateXnt ?? DEFAULT_CLAIM_RATE_XNT,
          dailyTapCap: payload.dailyTapCap ?? DEFAULT_DAILY_TAP_CAP,
          initialTreasuryMind: payload.initialTreasuryMind ?? DEFAULT_INITIAL_TREASURY_MIND,
          payoutWalletLabel: payload.payoutWalletLabel ?? "Registered season wallet",
          fundingWalletLabel: payload.fundingWalletLabel ?? "Clicker funding wallet",
          seasonName: payload.seasonName ?? "Season 0",
          mode: payload.mode ?? "test",
        });
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    try {
      const payload: ClickerState = { taps, claimableMind, seasonMind, claimStatus, feed, lastAction };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore cache errors
    }
  }, [claimStatus, claimableMind, feed, lastAction, seasonMind, taps]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<ClickerState>;
      if (typeof parsed.taps === "number") setTaps(parsed.taps);
      if (typeof parsed.claimableMind === "number") setClaimableMind(parsed.claimableMind);
      if (typeof parsed.seasonMind === "number") setSeasonMind(parsed.seasonMind);
      if (parsed.claimStatus === "none" || parsed.claimStatus === "pending" || parsed.claimStatus === "ready") {
        setClaimStatus(parsed.claimStatus);
      }
      if (typeof parsed.lastAction === "string") setLastAction(parsed.lastAction);
      if (Array.isArray(parsed.feed)) setFeed(parsed.feed.filter((value): value is string => typeof value === "string"));
    } catch {
      // ignore malformed cache
    }
  }, []);

  const claimCostXnt = useMemo(() => claimableMind * config.claimRateXnt, [claimableMind, config.claimRateXnt]);
  const tapsLeft = Math.max(0, config.dailyTapCap - taps);
  const progress = Math.min(100, (taps / config.dailyTapCap) * 100);

  const pushFeed = (line: string) => setFeed((current) => [line, ...current].slice(0, 5));

  const flashBurst = (value: string) => {
    const id = burstIdRef.current + 1;
    burstIdRef.current = id;
    setBurst({
      id,
      value,
      top: 22 + Math.floor(Math.random() * 42),
      left: 28 + Math.floor(Math.random() * 44),
    });
    window.setTimeout(() => {
      setBurst((current) => (current?.id === id ? null : current));
    }, 700);
  };

  const tapReactor = () => {
    if (taps >= config.dailyTapCap) {
      setLastAction("Daily tap cap reached.");
      pushFeed("Daily cap reached. Come back tomorrow.");
      return;
    }

    setPulse(true);
    window.setTimeout(() => setPulse(false), 180);
    setTaps((current) => current + 1);
    setClaimableMind((current) => Number((current + 0.0012).toFixed(4)));
    setSeasonMind((current) => Number((current + 0.0012).toFixed(4)));
    setClaimStatus("none");
    setLastAction("Reactor tapped.");
    pushFeed("Reactor hit: +0.0012 MIND claimable.");
    flashBurst("+0.0012");
  };

  const beginClaim = () => {
    if (claimableMind <= 0) {
      setLastAction("Nothing to claim.");
      pushFeed("Claim blocked: no MIND available.");
      return;
    }

    setClaimStatus("pending");
    setLastAction(`Claim ready at ${formatXnt(claimCostXnt)} XNT.`);
    pushFeed(`Claim opened: ${formatMind(claimableMind)} MIND for ${formatXnt(claimCostXnt)} XNT.`);
  };

  const confirmClaim = () => {
    if (claimStatus !== "pending") return;
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

    const label = claimStatus === "pending" ? "Confirm Claim" : "Tap Reactor";
    webApp.MainButton.setText?.(label);
    webApp.MainButton.show?.();

    const onClick = () => {
      if (claimStatus === "pending") {
        confirmClaim();
        return;
      }
      tapReactor();
    };

    webApp.MainButton.offClick?.(onClick);
    webApp.MainButton.onClick?.(onClick);
    return () => {
      webApp.MainButton.offClick?.(onClick);
    };
  }, [claimStatus]);

  return (
    <main className="min-h-screen bg-[#03060a] px-4 py-5 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex min-h-[calc(100vh-2.5rem)] w-full max-w-5xl flex-col gap-4">
        <Card className="border-cyan-400/15 bg-[#081018]/90 p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-300/75">MIND FACTORY // TELEGRAMBOT</p>
              <h1 className="text-2xl font-semibold text-white sm:text-3xl">Factory Clicker</h1>
              <p className="max-w-2xl text-sm leading-6 text-zinc-300">
                Tap the reactor core. Build claimable MIND. Fund claims with XNT. Payouts stay tied to the season wallet registered at the start of the season.
              </p>
            </div>

            <div className="grid gap-2 text-xs text-zinc-300 sm:grid-cols-2 lg:min-w-[320px]">
              <div className="rounded-2xl border border-cyan-400/10 bg-white/5 p-3">
                <div className="text-zinc-500">Payout wallet</div>
                <div className="mt-1 font-mono text-sm text-white">{config.payoutWalletLabel}</div>
              </div>
              <div className="rounded-2xl border border-cyan-400/10 bg-white/5 p-3">
                <div className="text-zinc-500">Funding wallet</div>
                <div className="mt-1 font-mono text-sm text-white">{config.fundingWalletLabel}</div>
              </div>
            </div>
          </div>
        </Card>

        <div className="grid gap-4 xl:grid-cols-[1.3fr_0.95fr]">
          <div className="space-y-4">
            <Card className="overflow-hidden border-cyan-400/15 bg-[#081018]/90 p-4">
              <div className="flex items-center justify-between text-xs uppercase tracking-[0.22em] text-zinc-500">
                <span>{config.seasonName}</span>
                <span>{config.mode}</span>
              </div>

              <button
                type="button"
                onClick={tapReactor}
                className="relative mt-4 block w-full overflow-hidden rounded-[28px] border border-cyan-400/10 bg-[#03060a] shadow-[0_18px_50px_rgba(0,0,0,0.45)]"
              >
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(34,211,238,0.12),_transparent_55%)]" />
                <div className={`relative aspect-square w-full transition-transform duration-150 ${pulse ? "scale-[0.985]" : "scale-100"}`}>
                  <ReactorCore pulse={pulse} />
                </div>
                {burst ? (
                  <span
                    className="pointer-events-none absolute z-20 rounded-full border border-cyan-200/30 bg-cyan-300/12 px-3 py-1 text-sm font-semibold text-cyan-100"
                    style={{ top: `${burst.top}%`, left: `${burst.left}%` }}
                  >
                    {burst.value}
                  </span>
                ) : null}
                <div className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-[#03060a] via-[#03060a]/80 to-transparent p-4">
                  <div className="flex items-end justify-between gap-3">
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
                  <div className="mt-2 text-2xl font-semibold text-white">{Math.round(progress)}%</div>
                </div>
              </div>

              <div className="mt-4">
                <div className="mb-2 flex items-center justify-between text-xs text-zinc-500">
                  <span>Daily line</span>
                  <span>{taps}/{config.dailyTapCap}</span>
                </div>
                <div className="h-2 rounded-full bg-white/5">
                  <div
                    className="h-2 rounded-full bg-gradient-to-r from-cyan-400 via-teal-300 to-emerald-300"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            </Card>

            <Card className="border-cyan-400/15 bg-[#081018]/90 p-4">
              <div className="grid gap-3 md:grid-cols-3">
                <Button size="lg" onClick={beginClaim} className="w-full">
                  Claim MIND
                </Button>
                <Button size="lg" variant="secondary" onClick={cancelClaim} className="w-full">
                  Cancel Claim
                </Button>
                <Button
                  size="lg"
                  variant="ghost"
                  onClick={() => webAppRef.current?.close?.()}
                  className="w-full"
                >
                  Close
                </Button>
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
                  <div key={`${index}-${line}`} className="rounded-2xl border border-white/5 bg-white/5 p-3 text-sm text-zinc-300">
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
                  The reactor is the tap target. Buttons below handle claim and exit.
                </div>
              </div>
            </Card>
          </div>
        </div>
      </div>
    </main>
  );
}
