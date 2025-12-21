"use client";

import { Card, CardHeader } from "@/components/ui/card";
import { TierBadge } from "@/components/xp/TierBadge";
import { XpProgress } from "@/components/xp/XpProgress";
import { useDashboard } from "@/components/dashboard/DashboardContext";

function formatBps(bps: number) {
  const percent = bps / 100;
  return `${percent % 1 === 0 ? percent.toFixed(0) : percent.toFixed(2)}%`;
}

export function MiningXpHero() {
  const { xpStats, userProfile, config } = useDashboard();
  const tierName = xpStats?.tierName ?? "Bronze";

  return (
    <Card className="border-cyan-400/20 bg-ink/90">
      <CardHeader
        title="XP Status"
        description="XP boosts staking weight only."
        right={<TierBadge tier={tierName as "Bronze" | "Silver" | "Gold" | "Diamond"} />}
      />

      <div className="mt-4 grid gap-4 lg:grid-cols-[2fr_1fr]">
        <XpProgress
          value={`${userProfile?.miningXp.toString() ?? "—"} XP`}
          label={xpStats?.nextTierName ? `Next: ${xpStats.nextTierName}` : "Max tier unlocked"}
          sublabel={
            xpStats?.nextTierName
              ? `${xpStats.remaining.toString()} XP to ${xpStats.nextTierName}`
              : "XP cap reached"
          }
          progress={xpStats?.progress ?? 0}
          className="bg-gradient-to-r from-cyan-400/10 via-emerald-300/10 to-transparent"
        />
        <div className="rounded-3xl border border-white/5 bg-white/5 p-4">
          <div className="text-xs text-zinc-400">Benefits</div>
          <div className="mt-3 grid gap-2 text-sm text-zinc-100">
            <div className="flex items-center justify-between">
              <span>Silver</span>
              <span className="font-mono text-zinc-200">
                +{formatBps(config?.xpBoostSilverBps ?? 0)} stake weight
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Gold</span>
              <span className="font-mono text-zinc-200">
                +{formatBps(config?.xpBoostGoldBps ?? 0)} stake weight
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Diamond</span>
              <span className="font-mono text-zinc-200">
                +{formatBps(config?.xpBoostDiamondBps ?? 0)} stake weight
              </span>
            </div>
          </div>
        </div>
      </div>

      <details className="group mt-5 rounded-3xl border border-white/5 bg-white/5 p-4">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.2em] text-zinc-300">
          What is XP?
        </summary>
        <div className="mt-3 text-xs text-zinc-400">
          XP boosts staking weight only; it does not mint tokens.
        </div>
      </details>
    </Card>
  );
}
