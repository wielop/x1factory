"use client";

import { useState } from "react";

export function HowItWorksPopover() {
  const [activeTab, setActiveTab] = useState<"flow" | "start">("flow");
  return (
    <details className="relative">
      <summary className="cursor-pointer rounded-full border border-rose-500/40 bg-rose-500/20 px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-rose-100 hover:bg-rose-500/30">
        How it works
      </summary>
      <div className="absolute right-0 mt-2 w-80 rounded-2xl border border-cyan-400/20 bg-ink/95 p-4 text-xs text-zinc-300 shadow-[0_0_24px_rgba(34,242,255,0.15)]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab("flow")}
            className={[
              "rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]",
              activeTab === "flow"
                ? "bg-white/10 text-white"
                : "text-zinc-500 hover:text-zinc-200",
            ].join(" ")}
          >
            How it works
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("start")}
            className={[
              "rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.2em]",
              activeTab === "start"
                ? "bg-white/10 text-white"
                : "text-zinc-500 hover:text-zinc-200",
            ].join(" ")}
          >
            Getting started
          </button>
        </div>

        {activeTab === "flow" ? (
          <div className="mt-4">
            <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">MINING FLOW</div>
            <ol className="mt-3 space-y-2 text-xs text-zinc-300">
              <li>
                1. Lock a mining rig to get hashpower (HP) for a fixed term. Your HP is fixed, but your share moves as
                the network grows or shrinks.
              </li>
              <li>2. Daily MIND emission is split pro-rata across all active HP.</li>
              <li>3. If network HP is zero, emission pauses.</li>
              <li>4. Claim MIND anytime. Your rigs keep running.</li>
              <li>5. When a rig expires, renew it or deactivate to free up HP.</li>
              <li>6. Stake MIND to earn XNT rewards from the pool.</li>
              <li>7. Rewards stream over time based on your share of the pool.</li>
              <li>8. Badges can boost staking rewards up to a +20% cap.</li>
            </ol>
          </div>
        ) : (
          <div className="mt-4 max-h-72 overflow-y-auto pr-1">
            <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
              Getting started – 6 simple steps
            </div>
            <div className="mt-3 space-y-3 text-xs text-zinc-300">
              <div>
                <div className="font-semibold text-zinc-200">1) Connect wallet & get XNT</div>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-300">
                  <li>Connect your X1 wallet.</li>
                  <li>Keep some XNT for rigs and a little extra for gas.</li>
                </ul>
              </div>
              <div>
                <div className="font-semibold text-zinc-200">2) Buy your first rig</div>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-300">
                  <li>Go to "Choose a rig" and pick Starter / Pro / Industrial.</li>
                  <li>Review HP, duration, and cost in the Selected card.</li>
                  <li>Click "Start mining" to launch the rig.</li>
                </ul>
              </div>
              <div>
                <div className="font-semibold text-zinc-200">3) Watch your share & emission</div>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-300">
                  <li>Main dashboard shows Your HP, Network HP, Your share, and Est. MIND/day.</li>
                  <li>Your share moves as other miners start or finish rigs.</li>
                </ul>
              </div>
              <div>
                <div className="font-semibold text-zinc-200">4) Claim MIND</div>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-300">
                  <li>As rigs run, MIND accrues in your rigs section.</li>
                  <li>Use "Start Claim" to collect from all active rigs.</li>
                  <li>Claiming does not stop mining.</li>
                </ul>
              </div>
              <div>
                <div className="font-semibold text-zinc-200">5) Stake MIND → earn XNT</div>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-300">
                  <li>In Staking, enter how much MIND you want to stake and click "Stake".</li>
                  <li>
                    30% of mining revenue funds the pool and rewards stream over time based on your share.
                  </li>
                  <li>Claim XNT anytime with "Claim XNT".</li>
                </ul>
              </div>
              <div>
                <div className="font-semibold text-zinc-200">6) Unstaking & burn</div>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-300">
                  <li>You can unstake MIND whenever you want.</li>
                  <li>
                    6% of unstaked MIND is burned – this helps stabilize rewards and discourages rapid in-out cycles.
                  </li>
                </ul>
              </div>
              <div>
                <div className="font-semibold text-zinc-200">Quick recap</div>
                <ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-300">
                  <li>Mining: XNT → time-limited HP → earn MIND.</li>
                  <li>Staking: MIND → pool share → earn XNT.</li>
                  <li>No fixed APR. Rewards come from real demand in the system.</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
