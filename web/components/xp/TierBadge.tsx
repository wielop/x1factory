"use client";

import { cn } from "@/components/ui/cn";

export function TierBadge({
  tier,
  className,
}: {
  tier: "Silver" | "Gold" | "Diamond" | "Bronze";
  className?: string;
}) {
  return (
    <span
      data-tier={tier}
      className={cn(
        "tier-badge inline-flex items-center rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]",
        className
      )}
    >
      {tier}
    </span>
  );
}
