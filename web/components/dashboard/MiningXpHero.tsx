"use client";

import { Card } from "@/components/ui/card";
import { TierBadge } from "@/components/xp/TierBadge";
import { XpProgress } from "@/components/xp/XpProgress";
import { useDashboard } from "@/components/dashboard/DashboardContext";

export function MiningXpHero() {
  const { xpStats, userProfile } = useDashboard();
  const tierName = xpStats?.tierName ?? "Bronze";

  return (
    <Card className="border-cyan-400/20 bg-ink/90">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Your XP</div>
          <div className="mt-2 text-2xl font-semibold text-white">Level up your rewards</div>
        </div>
        <TierBadge tier={tierName as "Bronze" | "Silver" | "Gold" | "Diamond"} />
      </div>

      <div className="mt-5">
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
      </div>
    </Card>
  );
}
