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
          <li>1) Buy a mining contract to get fixed hashpower (HP) for a set time.</li>
          <li>2) Global MIND emission is split pro-rata to active HP; if network HP is zero, emission pauses.</li>
          <li>3) Claim MIND anytime; expired contracts can be deactivated to free HP.</li>
          <li>4) Stake MIND to earn XNT rewards (smoothed per epoch).</li>
          <li>5) Badges boost staking payouts up to +20%.</li>
        </ol>
      </div>
    </details>
  );
}
