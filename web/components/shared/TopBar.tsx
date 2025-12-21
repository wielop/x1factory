"use client";

import Link from "next/link";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { cn } from "@/components/ui/cn";
import { InfoPopover } from "@/components/shared/InfoPopover";
import { TierBadge } from "@/components/xp/TierBadge";

export function TopBar({
  title,
  subtitle,
  link,
  tier,
  className,
}: {
  title: string;
  subtitle?: string;
  link?: { href: string; label: string };
  tier?: "Bronze" | "Silver" | "Gold" | "Diamond";
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
          {link ? (
            <Link className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-300 hover:text-white" href={link.href}>
              {link.label}
            </Link>
          ) : null}
          {tier ? <TierBadge tier={tier} /> : null}
          <WalletMultiButton />
        </div>
      </div>
    </header>
  );
}
