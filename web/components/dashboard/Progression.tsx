"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Card } from "@/components/ui/card";
import { TopBar } from "@/components/shared/TopBar";
import { deriveUserProfilePda, fetchConfig, type DecodedConfig } from "@/lib/solana";
import { decodeUserMiningProfileAccount } from "@/lib/decoders";
import { LEVELING_ENABLED, LEVELING_DISABLED_MESSAGE } from "@/lib/leveling";
import { computeEstWeeklyXnt, getWeeklyPoolXnt } from "@/lib/yieldMath";
import { useYieldSummary } from "@/lib/useYieldSummary";

const LEVEL_ROWS = [
  { levelNumber: 1, level: "Level 1", xp: "0 XP", bonus: "0.0%", cost: "-" },
  { levelNumber: 2, level: "Level 2", xp: "500 XP", bonus: "+1.6%", cost: "100 MIND" },
  { levelNumber: 3, level: "Level 3", xp: "2,000 XP", bonus: "+3.4%", cost: "200 MIND" },
  { levelNumber: 4, level: "Level 4", xp: "5,000 XP", bonus: "+5.5%", cost: "450 MIND" },
  { levelNumber: 5, level: "Level 5", xp: "10,000 XP", bonus: "+7.8%", cost: "1,000 MIND" },
  { levelNumber: 6, level: "Level 6", xp: "16,000 XP", bonus: "+10.0% (cap)", cost: "2,000 MIND" },
] as const;

export function Progression() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [config, setConfig] = useState<DecodedConfig | null>(null);
  const [userLevel, setUserLevel] = useState(1);
  const [poolOverride, setPoolOverride] = useState("");
  const { data: yieldSummary, error: yieldError, loading: yieldLoading, reload } =
    useYieldSummary();

  useEffect(() => {
    let active = true;
    if (!publicKey) {
      setUserLevel(1);
      return undefined;
    }
    void (async () => {
      try {
        const info = await connection.getAccountInfo(deriveUserProfilePda(publicKey), "confirmed");
        if (!active) return;
        if (!info) {
          setUserLevel(1);
          return;
        }
        const decoded = decodeUserMiningProfileAccount(info.data);
        setUserLevel(Math.max(decoded.level ?? 1, 1));
      } catch {
        if (active) setUserLevel(1);
      }
    })();
    return () => {
      active = false;
    };
  }, [connection, publicKey]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const cfg = await fetchConfig(connection);
        if (active) setConfig(cfg);
      } catch {
        if (active) setConfig(null);
      }
    })();
    return () => {
      active = false;
    };
  }, [connection]);

  const isAdmin = Boolean(publicKey && config && publicKey.equals(config.admin));
  const levelingEnabled = LEVELING_ENABLED || isAdmin;
  const progressionLabel = levelingEnabled ? `LVL ${userLevel}` : "Levels paused";
  const weeklyPoolXnt = useMemo(() => {
    const parsed = Number(poolOverride);
    if (poolOverride.trim() && Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
    return yieldSummary?.poolXnt ?? getWeeklyPoolXnt();
  }, [poolOverride, yieldSummary]);
  const totalWeight = yieldSummary?.totalWeight ?? 0;

  const formatEstXnt = (levelNumber: number) => {
    const est = computeEstWeeklyXnt(levelNumber, totalWeight, weeklyPoolXnt);
    if (!est) return "—";
    return `${est.toFixed(2)} XNT`;
  };

  return (
    <div className="min-h-screen bg-ink text-white">
      <TopBar progressionLabel={progressionLabel} />

      <main className="mx-auto max-w-5xl px-4 pb-20 pt-10">
        {levelingEnabled ? (
          <div className="space-y-4">
            <Card className="border-cyan-400/20 bg-ink/90 p-6">
              <div className="text-2xl font-semibold text-white">Account Level & XP</div>
              <div className="mt-2 text-sm text-zinc-300">
                Your account earns XP automatically while your rigs are mining.
                XP depends on two things: how much hashpower (HP) you have and how long it stays active.
                When you reach a new level, you get a small permanent bonus to your effective HP, which
                increases your share of the daily MIND emission.
              </div>
            </Card>

            <div id="level-overview">
              <Card className="border-cyan-400/20 bg-ink/90 p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="text-sm font-semibold text-white">Level overview</div>
                {yieldError ? (
                  <div className="flex items-center gap-2 text-[11px] text-amber-200">
                    <span>Unable to load yield estimates.</span>
                    <button
                      type="button"
                      onClick={reload}
                      className="rounded-full border border-amber-200/40 px-2 py-0.5 text-[10px] uppercase tracking-[0.2em] text-amber-100"
                    >
                      Retry
                    </button>
                  </div>
                ) : null}
              </div>
              <div className="mt-4 grid gap-2 text-xs text-zinc-300">
                <div className="grid grid-cols-5 gap-3 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  <div>Level</div>
                  <div>XP required</div>
                  <div>HP bonus</div>
                  <div>Level up cost</div>
                  <div className="flex items-center gap-1">
                    <span>Est. Weekly XNT</span>
                    <span
                      title="Estimates only. Depends on Weekly Yield Pool and number of eligible LVL holders. Not guaranteed."
                      className="cursor-help text-[10px] text-zinc-500"
                    >
                      i
                    </span>
                  </div>
                </div>
                {LEVEL_ROWS.map((row) => (
                  <div
                    key={row.level}
                    className="grid grid-cols-5 gap-3 rounded-xl border border-white/5 bg-white/5 px-3 py-2"
                  >
                    <div className="text-zinc-100">{row.level}</div>
                    <div className="text-zinc-300">{row.xp}</div>
                    <div className="text-emerald-200">{row.bonus}</div>
                    <div className="text-zinc-300">{row.cost}</div>
                    <div className="text-zinc-200">
                      {yieldLoading && !yieldSummary ? "..." : formatEstXnt(row.levelNumber)}
                    </div>
                  </div>
                ))}
              </div>
                <div className="mt-4 flex flex-wrap items-center gap-3 text-[11px] text-zinc-400">
                  <div>
                    Weekly Yield Pool: <span className="text-zinc-200">{weeklyPoolXnt} XNT</span>
                  </div>
                  <label className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                    Simulate pool
                    <input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      value={poolOverride}
                      onChange={(event) => setPoolOverride(event.target.value)}
                      placeholder={`${yieldSummary?.poolXnt ?? getWeeklyPoolXnt()}`}
                      className="h-7 w-24 rounded-md border border-white/10 bg-white/5 px-2 text-[11px] text-zinc-100 placeholder:text-zinc-600"
                    />
                  </label>
                </div>
              </Card>
            </div>

            <Card className="border-emerald-400/20 bg-ink/90 p-6">
              <div className="text-sm font-semibold text-white">What the bonus actually changes</div>
              <div className="mt-2 text-sm text-zinc-300">
                The bonus only increases your personal share of the emission by boosting your effective HP.
                Global MIND emission stays the same. A higher level does not mint extra tokens, it only gives
                you a slightly larger slice of the same daily pool as long as you keep mining.
              </div>
            </Card>

            <Card className="border-cyan-400/20 bg-ink/90 p-6">
              <div className="text-sm font-semibold text-white">How to level up faster</div>
              <div className="mt-2 text-sm text-zinc-300">
                Keep your rigs active for longer periods. More HP and more uptime means more XP.
                When you have enough XP and MIND tokens, you can use the level up action in the future versions
                of the app to reach the next tier and increase your HP bonus.
              </div>
            </Card>
          </div>
        ) : (
          <div className="space-y-4">
            <Card className="border-cyan-400/20 bg-ink/90 p-6 text-center">
              <div className="text-sm font-semibold text-white">Account progression is paused</div>
              <div className="mt-2 text-xs text-zinc-300">{LEVELING_DISABLED_MESSAGE}</div>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}
