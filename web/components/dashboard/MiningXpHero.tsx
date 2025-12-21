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
          <div className="mt-2 text-lg font-semibold text-cyan-200">{tierName}</div>
        </div>
        <div className="flex items-center gap-2">
          <svg
            className="h-5 w-5 text-cyan-200"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M12 3l3 6 6 .8-4.5 4.2 1.3 6-5.8-3.2L6.2 20l1.3-6L3 9.8 9 9l3-6z" />
          </svg>
          <TierBadge
            tier={tierName as "Bronze" | "Silver" | "Gold" | "Diamond"}
            className="px-4 py-1.5 text-[11px]"
          />
        </div>
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
