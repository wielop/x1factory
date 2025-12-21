"use client";

import { Badge } from "@/components/ui/badge";
import { CopyButton } from "@/components/shared/CopyButton";
import { useDashboard } from "@/components/dashboard/DashboardContext";
import { explorerTxUrl } from "@/lib/format";

export function TransactionStatus() {
  const { lastSig } = useDashboard();
  if (!lastSig) return null;

  return (
    <div className="fixed inset-x-0 bottom-4 z-40 px-4">
      <div className="mx-auto max-w-6xl rounded-2xl border border-cyan-400/20 bg-ink/90 p-3 shadow-[0_0_24px_rgba(34,242,255,0.12)]">
        <details>
          <summary className="flex cursor-pointer items-center justify-between text-[11px] font-semibold uppercase tracking-[0.2em] text-zinc-300">
            Transaction
            <Badge variant="muted">expand</Badge>
          </summary>
          <div className="mt-3 grid gap-2 text-xs text-zinc-400">
            <div className="rounded-xl border border-white/10 bg-white/5 p-2 font-mono text-[11px] text-zinc-200">
              {lastSig}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a href={explorerTxUrl(lastSig)} target="_blank" rel="noreferrer">
                Explorer
              </a>
              <CopyButton text={lastSig} label="Copy sig" size="sm" />
            </div>
          </div>
        </details>
      </div>
    </div>
  );
}
