"use client";

import { rpcUrl, getProgramId } from "@/lib/solana";
import { shortPk } from "@/lib/format";

export function InfoPopover() {
  const url = rpcUrl();
  const programId = getProgramId().toBase58();
  return (
    <details className="relative">
      <summary className="cursor-pointer rounded-full border border-cyan-400/20 bg-ink/70 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-300">
        Info
      </summary>
      <div className="absolute right-0 mt-2 w-64 rounded-2xl border border-cyan-400/20 bg-ink/95 p-4 text-xs text-zinc-300 shadow-[0_0_24px_rgba(34,242,255,0.15)]">
        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">RPC</div>
        <div className="mt-1 font-mono">{url.replace(/^https?:\/\//, "")}</div>
        <div className="mt-3 text-[10px] uppercase tracking-[0.2em] text-zinc-500">Program</div>
        <div className="mt-1 font-mono" title={programId}>
          {shortPk(programId, 8)}
        </div>
      </div>
    </details>
  );
}
