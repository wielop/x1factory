"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const DEFAULT_CLAIM_RATE_XNT = 0.015;
const DEFAULT_DAILY_TAP_CAP = 50;
const DEFAULT_INITIAL_TREASURY_MIND = 5000;
const STORAGE_KEY = "x1factory.telegrambot.reactor.v2";

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
  reactorCoreLevel: number;
  fuelCellLevel: number;
  claimTerminalLevel: number;
  stabilityModuleLevel: number;
};

type Burst = { id: number; value: string; top: number; left: number };
type FeedItem = { title: string; detail: string };
type ModuleKey = "reactor" | "fuel" | "claim" | "stability";

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

function ModulePill({
  title,
  level,
  detail,
  onUpgrade,
}: {
  title: string;
  level: number;
  detail: string;
  onUpgrade: () => void;
}) {
  return (
    <div className="rounded-2xl border border-cyan-400/10 bg-white/5 p-4">
      <div className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">{title}</div>
      <div className="mt-1 text-lg font-semibold text-white">Lv {level}</div>
      <div className="mt-2 text-xs leading-5 text-zinc-400">{detail}</div>
      <Button size="sm" variant="secondary" className="mt-3 h-10 w-full" onClick={onUpgrade}>
        Upgrade
      </Button>
    </div>
  );
}

function CollapsibleSection({
  title,
  subtitle,
  children,
  defaultOpen = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="group rounded-3xl border border-cyan-400/15 bg-[#081018]/90 p-4">
      <summary className="cursor-pointer list-none select-none">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
            {subtitle ? <p className="mt-1 text-xs text-zinc-500">{subtitle}</p> : null}
          </div>
          <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-zinc-400 transition group-open:text-cyan-200">
            Tap
          </div>
        </div>
      </summary>
      <div className="mt-4">{children}</div>
    </details>
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
  const [reactorCoreLevel, setReactorCoreLevel] = useState(1);
  const [fuelCellLevel, setFuelCellLevel] = useState(1);
  const [claimTerminalLevel, setClaimTerminalLevel] = useState(1);
  const [stabilityModuleLevel, setStabilityModuleLevel] = useState(1);
  const [feed, setFeed] = useState<FeedItem[]>([
    { title: "Factory online", detail: "Tap the reactor core to build claimable MIND." },
    { title: "Wallet split", detail: "Funding wallet takes XNT. Season wallet receives payouts." },
    { title: "Season line", detail: "Season 0 is test mode. Season 1 starts clean." },
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
      const payload: ClickerState = {
        taps,
        claimableMind,
        seasonMind,
        claimStatus,
        feed: feed.map((item) => `${item.title}::${item.detail}`),
        lastAction,
        reactorCoreLevel,
        fuelCellLevel,
        claimTerminalLevel,
        stabilityModuleLevel,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // ignore cache errors
    }
  }, [claimStatus, claimableMind, feed, lastAction, seasonMind, taps, reactorCoreLevel, fuelCellLevel, claimTerminalLevel, stabilityModuleLevel]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<ClickerState>;
      if (typeof parsed.taps === "number") setTaps(parsed.taps);
      if (typeof parsed.claimableMind === "number") setClaimableMind(parsed.claimableMind);
      if (typeof parsed.seasonMind === "number") setSeasonMind(parsed.seasonMind);
      if (parsed.claimStatus === "none" || parsed.claimStatus === "pending" || parsed.claimStatus === "ready") setClaimStatus(parsed.claimStatus);
      if (typeof parsed.lastAction === "string") setLastAction(parsed.lastAction);
      if (typeof parsed.reactorCoreLevel === "number") setReactorCoreLevel(Math.max(1, parsed.reactorCoreLevel));
      if (typeof parsed.fuelCellLevel === "number") setFuelCellLevel(Math.max(1, parsed.fuelCellLevel));
      if (typeof parsed.claimTerminalLevel === "number") setClaimTerminalLevel(Math.max(1, parsed.claimTerminalLevel));
      if (typeof parsed.stabilityModuleLevel === "number") setStabilityModuleLevel(Math.max(1, parsed.stabilityModuleLevel));
      if (Array.isArray(parsed.feed)) {
        setFeed(
          parsed.feed
            .filter((value): value is string => typeof value === "string")
            .map((value) => {
              const [title, detail] = value.split("::");
              return { title: title ?? "Factory feed", detail: detail ?? value };
            })
        );
      }
    } catch {
      // ignore malformed cache
    }
  }, []);

  const claimCostXnt = useMemo(() => claimableMind * config.claimRateXnt, [claimableMind, config.claimRateXnt]);
  const tapsLeft = Math.max(0, config.dailyTapCap - taps);
  const progress = Math.min(100, (taps / config.dailyTapCap) * 100);
  const operatorLevel = Math.max(1, reactorCoreLevel + fuelCellLevel + claimTerminalLevel + stabilityModuleLevel - 3);
  const tapPower = (0.0012 * (1 + (reactorCoreLevel - 1) * 0.18)).toFixed(4);
  const claimRate = (config.claimRateXnt * Math.max(0.7, 1 - (claimTerminalLevel - 1) * 0.04)).toFixed(3);
  const streakBonus = `${Math.min(25, 5 + (stabilityModuleLevel - 1) * 5)}%`;
  const energyCap = config.dailyTapCap + (fuelCellLevel - 1) * 10;

  const pushFeed = (title: string, detail: string) => setFeed((current) => [{ title, detail }, ...current].slice(0, 5));
  const flashBurst = (value: string) => {
    const id = burstIdRef.current + 1;
    burstIdRef.current = id;
    setBurst({ id, value, top: 22 + Math.floor(Math.random() * 42), left: 28 + Math.floor(Math.random() * 44) });
    window.setTimeout(() => setBurst((current) => (current?.id === id ? null : current)), 700);
  };

  const tapReactor = () => {
    if (taps >= config.dailyTapCap) {
      setLastAction("Daily tap cap reached.");
      pushFeed("Daily cap reached", "Come back tomorrow.");
      return;
    }

    setPulse(true);
    window.setTimeout(() => setPulse(false), 180);
    setTaps((current) => current + 1);
    setClaimableMind((current) => Number((current + Number(tapPower)).toFixed(4)));
    setSeasonMind((current) => Number((current + Number(tapPower)).toFixed(4)));
    setClaimStatus("none");
    setLastAction("Reactor tapped.");
    pushFeed("Reactor hit", `+${tapPower} MIND claimable.`);
    flashBurst(`+${tapPower}`);
  };

  const beginClaim = () => {
    if (claimableMind <= 0) {
      setLastAction("Nothing to claim.");
      pushFeed("Claim blocked", "Build some balance first.");
      return;
    }

    setClaimStatus("pending");
    setLastAction(`Claim ready at ${formatXnt(claimCostXnt)} XNT.`);
    pushFeed("Claim opened", `${formatMind(claimableMind)} MIND for ${formatXnt(claimCostXnt)} XNT.`);
  };

  const confirmClaim = () => {
    if (claimStatus !== "pending") return;
    setClaimStatus("ready");
    setLastAction("Claim marked ready for settlement.");
    pushFeed("Claim ready", "MIND goes to the registered season wallet after funding.");
  };

  const cancelClaim = () => {
    setClaimStatus("none");
    setLastAction("Claim cancelled.");
    pushFeed("Claim cancelled", "You can keep tapping and try again later.");
  };

  const upgradeModule = (module: ModuleKey) => {
    if (module === "reactor") {
      setReactorCoreLevel((current) => Math.min(10, current + 1));
      pushFeed("Upgrade installed", "Reactor Core output increased.");
      setLastAction("Reactor Core upgraded.");
      return;
    }

    if (module === "fuel") {
      setFuelCellLevel((current) => Math.min(10, current + 1));
      pushFeed("Upgrade installed", "Fuel Cell increased daily energy.");
      setLastAction("Fuel Cell upgraded.");
      return;
    }

    if (module === "claim") {
      setClaimTerminalLevel((current) => Math.min(10, current + 1));
      pushFeed("Upgrade installed", "Claim Terminal lowered claim friction.");
      setLastAction("Claim Terminal upgraded.");
      return;
    }

    setStabilityModuleLevel((current) => Math.min(10, current + 1));
    pushFeed("Upgrade installed", "Stability Module improved streak safety.");
    setLastAction("Stability Module upgraded.");
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
    return () => webApp.MainButton.offClick?.(onClick);
  }, [claimStatus]);

  return (
    <main className="min-h-screen bg-[#03060a] px-3 py-3 text-zinc-100 sm:px-4 sm:py-4 lg:px-6">
      <div className="mx-auto flex min-h-[calc(100vh-1.5rem)] w-full max-w-4xl flex-col gap-3 sm:min-h-[calc(100vh-2rem)]">
        <Card className="border-cyan-400/15 bg-[#081018]/90 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-[0.26em] text-cyan-300/75">MIND FACTORY // TELEGRAMBOT</p>
              <h1 className="mt-1 text-xl font-semibold text-white sm:text-2xl">Factory Clicker</h1>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-300 sm:text-sm sm:leading-6">
                Tap the reactor core. Build claimable MIND. Fund claims with XNT. Payouts stay tied to the season wallet registered at the start of the season.
              </p>
            </div>
            <div className="hidden shrink-0 rounded-2xl border border-cyan-400/10 bg-white/5 px-3 py-2 text-right text-xs text-zinc-300 sm:block">
              <div className="text-zinc-500">Season</div>
              <div className="mt-1 font-mono text-sm text-white">{config.seasonName}</div>
            </div>
          </div>
        </Card>

        <Card className="border-cyan-400/15 bg-[#081018]/90 px-4 py-3 sm:hidden">
          <div className="grid grid-cols-2 gap-3 text-xs text-zinc-300">
            <div className="rounded-2xl border border-cyan-400/10 bg-white/5 p-3">
              <div className="text-zinc-500">Claimable</div>
              <div className="mt-1 text-lg font-semibold text-white">{formatMind(claimableMind)}</div>
            </div>
            <div className="rounded-2xl border border-cyan-400/10 bg-white/5 p-3">
              <div className="text-zinc-500">Operator Lv</div>
              <div className="mt-1 text-lg font-semibold text-white">{operatorLevel}</div>
            </div>
          </div>
        </Card>

        <div className="grid flex-1 gap-3 xl:grid-cols-[1.25fr_0.75fr]">
          <div className="space-y-3">
            <Card className="overflow-hidden border-cyan-400/15 bg-[#081018]/90 p-3 sm:p-4">
              <div className="flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.22em] text-zinc-500 sm:text-xs">
                <span>{config.mode === "test" ? "test mode" : "live mode"}</span>
                <span>{tapsLeft}/{config.dailyTapCap} taps left</span>
              </div>

              <button
                type="button"
                onClick={tapReactor}
                aria-label="Tap reactor core"
                className="relative mt-3 block w-full overflow-hidden rounded-[30px] border border-cyan-400/10 bg-[#03060a] shadow-[0_18px_50px_rgba(0,0,0,0.45)] active:scale-[0.995] touch-manipulation"
              >
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_rgba(34,211,238,0.12),_transparent_55%)]" />
                <div className={`relative aspect-[4/5] w-full transition-transform duration-150 ${pulse ? "scale-[0.985]" : "scale-100"}`}>
                  <ReactorCore pulse={pulse} />
                </div>
                {burst ? (
                  <span
                    className="pointer-events-none absolute z-20 rounded-full border border-cyan-200/30 bg-cyan-300/12 px-3 py-1 text-sm font-semibold text-cyan-100 shadow-[0_0_18px_rgba(34,242,255,0.2)]"
                    style={{ top: `${burst.top}%`, left: `${burst.left}%`, transform: "translate(-50%, -50%)" }}
                  >
                    {burst.value}
                  </span>
                ) : null}
                <div className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-[#03060a] via-[#03060a]/80 to-transparent p-3 sm:p-4">
                  <div className="flex items-end justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[10px] uppercase tracking-[0.22em] text-zinc-400 sm:text-xs">Tap reactor</div>
                      <div className="mt-1 truncate text-base font-semibold text-white sm:text-lg">{formatMind(claimableMind)} claimable MIND</div>
                    </div>
                    <div className="rounded-2xl border border-cyan-400/15 bg-cyan-400/10 px-3 py-2 text-right text-xs text-cyan-100">
                      <div className="text-cyan-100/60">Tap line</div>
                      <div className="mt-1 text-sm font-semibold sm:text-base">{progress.toFixed(0)}%</div>
                    </div>
                  </div>
                </div>
              </button>

              <div className="mt-3 grid grid-cols-3 gap-2 sm:mt-4 sm:gap-3">
                <div className="rounded-2xl border border-white/5 bg-white/5 p-3 sm:p-4">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500 sm:text-xs">Claimable</div>
                  <div className="mt-2 text-lg font-semibold text-white sm:text-2xl">{formatMind(claimableMind)}</div>
                </div>
                <div className="rounded-2xl border border-white/5 bg-white/5 p-3 sm:p-4">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500 sm:text-xs">Season</div>
                  <div className="mt-2 text-lg font-semibold text-white sm:text-2xl">{formatMind(seasonMind)}</div>
                </div>
                <div className="rounded-2xl border border-white/5 bg-white/5 p-3 sm:p-4">
                  <div className="text-[10px] uppercase tracking-wide text-zinc-500 sm:text-xs">Lv</div>
                  <div className="mt-2 text-lg font-semibold text-white sm:text-2xl">{operatorLevel}</div>
                </div>
              </div>
            </Card>

            <Card className="border-cyan-400/15 bg-[#081018]/90 p-3 sm:p-4">
              <div className="grid grid-cols-3 gap-2 sm:gap-3">
                <Button size="lg" onClick={beginClaim} className="h-12 w-full text-sm sm:h-11 sm:text-base">
                  Claim
                </Button>
                <Button size="lg" variant="secondary" onClick={cancelClaim} className="h-12 w-full text-sm sm:h-11 sm:text-base">
                  Cancel
                </Button>
                <Button size="lg" variant="ghost" onClick={() => webAppRef.current?.close?.()} className="h-12 w-full text-sm sm:h-11 sm:text-base">
                  Exit
                </Button>
              </div>
              <div className="mt-3 rounded-2xl border border-cyan-400/10 bg-white/5 p-3 text-xs leading-5 text-zinc-300 sm:p-4 sm:text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-zinc-500">Status:</span>
                  <span className="text-white">{lastAction}</span>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-zinc-500">Claim:</span>
                  <span className="font-medium text-cyan-300">{claimStatus}</span>
                  <span className="text-zinc-500">Fee:</span>
                  <span className="font-medium text-white">{formatXnt(claimCostXnt)} XNT</span>
                </div>
              </div>
            </Card>

            <CollapsibleSection title="Workshop" subtitle="Upgrade the four modules. Costs are paid in MIND from the line." defaultOpen={false}>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <ModulePill title="Reactor Core" level={reactorCoreLevel} detail={`Tap power ${tapPower} MIND`} onUpgrade={() => upgradeModule("reactor")} />
                <ModulePill title="Fuel Cell" level={fuelCellLevel} detail={`Daily cap ${energyCap}`} onUpgrade={() => upgradeModule("fuel")} />
                <ModulePill title="Claim Terminal" level={claimTerminalLevel} detail={`Claim fee ${claimRate} XNT / MIND`} onUpgrade={() => upgradeModule("claim")} />
                <ModulePill title="Stability Module" level={stabilityModuleLevel} detail={`Streak bonus ${streakBonus}`} onUpgrade={() => upgradeModule("stability")} />
              </div>
            </CollapsibleSection>
          </div>

          <div className="space-y-3">
            <CollapsibleSection title="Play styles" subtitle="Pick a path and focus your upgrades." defaultOpen={false}>
              <div className="space-y-2 text-sm text-zinc-300">
                <div className="rounded-2xl border border-white/5 bg-white/5 p-3">
                  <div className="font-semibold text-white">Grinder</div>
                  <div className="mt-1 text-zinc-400">Push Reactor Core and Fuel Cell first. Tap more, claim later.</div>
                </div>
                <div className="rounded-2xl border border-white/5 bg-white/5 p-3">
                  <div className="font-semibold text-white">Optimizer</div>
                  <div className="mt-1 text-zinc-400">Upgrade Claim Terminal and Stability Module to reduce friction and smooth claims.</div>
                </div>
                <div className="rounded-2xl border border-white/5 bg-white/5 p-3">
                  <div className="font-semibold text-white">Balanced</div>
                  <div className="mt-1 text-zinc-400">Split upgrades across all four modules to keep taps, fees, and streaks aligned.</div>
                </div>
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="Factory feed" subtitle="Live reactor updates and recent actions." defaultOpen>
              <div className="space-y-2">
                {feed.map((item, index) => (
                  <div key={`${item.title}-${index}`} className="rounded-2xl border border-white/5 bg-white/5 p-3 text-sm text-zinc-300">
                    <div className="font-semibold text-zinc-100">{item.title}</div>
                    <div className="mt-1 leading-6 text-zinc-300/80">{item.detail}</div>
                  </div>
                ))}
              </div>
            </CollapsibleSection>

            <CollapsibleSection title="Wiring" subtitle="Wallet split and settlement flow." defaultOpen={false}>
              <div className="space-y-2 text-sm text-zinc-300">
                <div className="flex items-center justify-between rounded-2xl border border-white/5 bg-white/5 px-3 py-2">
                  <span>Season wallet</span>
                  <span className="font-mono text-zinc-100">{config.payoutWalletLabel}</span>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-white/5 bg-white/5 px-3 py-2">
                  <span>Funding wallet</span>
                  <span className="font-mono text-zinc-100">{config.fundingWalletLabel}</span>
                </div>
                <div className="rounded-2xl border border-white/5 bg-white/5 px-3 py-2 text-zinc-400">
                  The reactor is the tap target. Buttons below handle claim, upgrades, and exit.
                </div>
              </div>
            </CollapsibleSection>
          </div>
        </div>

        <div className="sticky bottom-2 z-30 mx-auto flex w-full max-w-4xl gap-2 rounded-[24px] border border-cyan-400/15 bg-[#061018]/95 p-2 shadow-[0_18px_50px_rgba(0,0,0,0.45)] backdrop-blur md:hidden">
          <Button size="lg" onClick={tapReactor} className="h-12 flex-1 text-sm">
            Tap
          </Button>
          <Button size="lg" variant="secondary" onClick={beginClaim} className="h-12 flex-1 text-sm">
            Claim
          </Button>
          <Button size="lg" variant="ghost" onClick={() => webAppRef.current?.close?.()} className="h-12 flex-1 text-sm">
            Exit
          </Button>
        </div>
      </div>
    </main>
  );
}
