"use client";

import Link from "next/link";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { cn } from "@/components/ui/cn";
import { InfoPopover } from "@/components/shared/InfoPopover";
import { HowItWorksPopover } from "@/components/shared/HowItWorksPopover";
import { TierBadge } from "@/components/xp/TierBadge";

export function TopBar({
  title,
  subtitle,
  link,
  tier,
  xpProgress,
  xpNextLabel,
  className,
}: {
  title: string;
  subtitle?: string;
  link?: { href: string; label: string };
  tier?: "Bronze" | "Silver" | "Gold" | "Diamond";
  xpProgress?: number | null;
  xpNextLabel?: string | null;
  className?: string;
}) {
  return (
    <header className={cn("sticky top-0 z-40 border-b border-cyan-400/10 bg-ink/80 backdrop-blur-xl", className)}>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-2xl border border-cyan-400/20 bg-cyan-400/10 shadow-[0_0_18px_rgba(34,242,255,0.2)]" />
          <div>
            <div className="text-sm font-semibold uppercase tracking-[0.22em] text-zinc-100">{title}</div>
            {subtitle ? <div className="text-[11px] text-zinc-400">{subtitle}</div> : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <InfoPopover />
          <HowItWorksPopover />
          {link ? (
            <Link className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-300 hover:text-white" href={link.href}>
              {link.label}
            </Link>
          ) : null}
          {tier ? (
            <div className="flex flex-col items-end gap-1">
              <TierBadge tier={tier} className="px-4 py-1.5 text-[11px]" />
              {xpProgress != null ? (
                <div className="w-24">
                  <div className="h-1 rounded-full bg-white/10">
                    <div className="h-1 rounded-full bg-cyan-300/70" style={{ width: `${xpProgress}%` }} />
                  </div>
                  {xpNextLabel ? (
                    <div className="mt-1 text-[10px] text-zinc-500">{xpNextLabel}</div>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <WalletMultiButton />
        </div>
      </div>
    </header>
  );
}
