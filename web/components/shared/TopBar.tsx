"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { cn } from "@/components/ui/cn";
import { InfoPopover } from "@/components/shared/InfoPopover";
import { HowItWorksPopover } from "@/components/shared/HowItWorksPopover";
import { TierBadge } from "@/components/xp/TierBadge";

export function TopBar({
  link,
  tier,
  xpProgress,
  xpNextLabel,
  progressionLabel,
  className,
}: {
  link?: { href: string; label: string };
  tier?: "Bronze" | "Silver" | "Gold" | "Diamond";
  xpProgress?: number | null;
  xpNextLabel?: string | null;
  progressionLabel?: string;
  className?: string;
}) {
  const pathname = usePathname();
  const isProgression = pathname === "/progression";

  return (
    <header className={cn("sticky top-0 z-40 border-b border-cyan-400/10 bg-ink/80 backdrop-blur-xl", className)}>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4">
        {/* Brand block now uses a single shared inline SVG logo + name/tagline link to home. */}
        <Link href="/" className="flex items-center gap-3">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            className="h-8 w-8 text-[#9BFFC6] drop-shadow-[0_0_12px_rgba(155,255,198,0.55)]"
            aria-hidden="true"
          >
            <path
              fill="currentColor"
              d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.03-1.58c.18-.14.23-.4.11-.61l-1.92-3.32a.48.48 0 0 0-.58-.22l-2.39.96a7.17 7.17 0 0 0-1.7-.98l-.36-2.54A.49.49 0 0 0 14.17 2h-4.34a.49.49 0 0 0-.49.41l-.36 2.54c-.62.24-1.19.56-1.7.98l-2.39-.96a.48.48 0 0 0-.58.22L2.39 8.83c-.12.21-.07.47.11.61l2.03 1.58c-.04.32-.07.64-.07.98s.03.66.07.98l-2.03 1.58a.5.5 0 0 0-.11.61l1.92 3.32c.12.21.37.3.58.22l2.39-.96c.51.42 1.08.74 1.7.98l.36 2.54c.04.23.24.41.49.41h4.34c.25 0 .45-.18.49-.41l.36-2.54c.62-.24 1.19-.56 1.7-.98l2.39.96c.21.08.46-.01.58-.22l1.92-3.32a.5.5 0 0 0-.11-.61l-2.03-1.58ZM12 15.25A3.25 3.25 0 1 1 12 8.75a3.25 3.25 0 0 1 0 6.5Z"
            />
          </svg>
          <div>
            <div className="text-base font-semibold uppercase tracking-[0.22em] text-zinc-100">
              MIND FACTORY
            </div>
            <div className="text-[11px] text-zinc-400">Mine, stake and grow your MIND.</div>
          </div>
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <InfoPopover />
          <HowItWorksPopover />
          <Link
            href="/progression"
            aria-current={isProgression ? "page" : undefined}
            className={cn(
              "inline-flex h-9 items-center justify-center rounded-full border px-3 text-[10px] font-semibold uppercase tracking-[0.2em] transition",
              isProgression
                ? "border-cyan-300/60 bg-ink/90 text-white"
                : "border-cyan-400/20 bg-ink/70 text-zinc-300 hover:border-cyan-300/40 hover:bg-ink/90"
            )}
          >
            {progressionLabel ?? "Progression"}
          </Link>
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
