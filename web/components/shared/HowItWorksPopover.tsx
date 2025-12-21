"use client";

export function HowItWorksPopover() {
  return (
    <details className="relative">
      <summary className="cursor-pointer rounded-full border border-cyan-400/20 bg-ink/70 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-zinc-300">
        How it works
      </summary>
      <div className="absolute right-0 mt-2 w-80 rounded-2xl border border-cyan-400/20 bg-ink/95 p-4 text-xs text-zinc-300 shadow-[0_0_24px_rgba(34,242,255,0.15)]">
        <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">Mining flow</div>
        <ol className="mt-3 space-y-2 text-xs text-zinc-300">
          <li>1) Choose a plan and deposit XNT (non-refundable per miner).</li>
          <li>2) Rewards accrue automatically every 24h epoch (no heartbeat).</li>
          <li>3) Claim MIND anytime; only full epochs are paid.</li>
          <li>4) XP boosts staking weight (XP never mints tokens).</li>
          <li>5) Stake MIND to amplify rewards.</li>
        </ol>
      </div>
    </details>
  );
}
