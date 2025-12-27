"use client";

import { Card } from "@/components/ui/card";
import { TopBar } from "@/components/shared/TopBar";

const LEVEL_ROWS = [
  { level: "Level 1", xp: "0 XP", bonus: "0.0%", cost: "-" },
  { level: "Level 2", xp: "1 XP", bonus: "+1.6%", cost: "150 MIND" },
  { level: "Level 3", xp: "2,000 XP", bonus: "+3.4%", cost: "350 MIND" },
  { level: "Level 4", xp: "5,000 XP", bonus: "+5.5%", cost: "900 MIND" },
  { level: "Level 5", xp: "10,000 XP", bonus: "+7.8%", cost: "2,000 MIND" },
  { level: "Level 6", xp: "16,000 XP", bonus: "+10.0% (cap)", cost: "4,000 MIND" },
] as const;

export function Progression() {
  return (
    <div className="min-h-screen bg-ink text-white">
      <TopBar />

      <main className="mx-auto max-w-5xl px-4 pb-20 pt-10">
        <div className="space-y-4">
          <Card className="border-cyan-400/20 bg-ink/90 p-6">
            <div className="text-2xl font-semibold text-white">Account Level & XP</div>
            <div className="mt-2 text-sm text-zinc-300">
              Your account earns XP automatically while your rigs are mining.
              XP depends on two things: how much hashpower (HP) you have and how long it stays active.
              When you reach a new level, you get a small permanent bonus to your effective HP, which
              increases your share of the daily MIND emission.
            </div>
          </Card>

          <Card className="border-cyan-400/20 bg-ink/90 p-6">
            <div className="text-sm font-semibold text-white">Level overview</div>
            <div className="mt-4 grid gap-2 text-xs text-zinc-300">
              <div className="grid grid-cols-4 gap-3 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                <div>Level</div>
                <div>XP required</div>
                <div>HP bonus</div>
                <div>Level up cost</div>
              </div>
              {LEVEL_ROWS.map((row) => (
                <div
                  key={row.level}
                  className="grid grid-cols-4 gap-3 rounded-xl border border-white/5 bg-white/5 px-3 py-2"
                >
                  <div className="text-zinc-100">{row.level}</div>
                  <div className="text-zinc-300">{row.xp}</div>
                  <div className="text-emerald-200">{row.bonus}</div>
                  <div className="text-zinc-300">{row.cost}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="border-emerald-400/20 bg-ink/90 p-6">
            <div className="text-sm font-semibold text-white">What the bonus actually changes</div>
            <div className="mt-2 text-sm text-zinc-300">
              The bonus only increases your personal share of the emission by boosting your effective HP.
              Global MIND emission stays the same. A higher level does not mint extra tokens, it only gives
              you a slightly larger slice of the same daily pool as long as you keep mining.
            </div>
          </Card>

          <Card className="border-cyan-400/20 bg-ink/90 p-6">
            <div className="text-sm font-semibold text-white">How to level up faster</div>
            <div className="mt-2 text-sm text-zinc-300">
              Keep your rigs active for longer periods. More HP and more uptime means more XP.
              When you have enough XP and MIND tokens, you can use the level up action in the future versions
              of the app to reach the next tier and increase your HP bonus.
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}
