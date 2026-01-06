"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function AccountProgressionPanel({
  level,
  xpLine,
  rateLine,
  bonusLine,
  description,
  progressLabel,
  progressPct,
  maxLevel,
  buttonLabel,
  buttonDisabled,
  requirements,
  onLevelUp,
}: {
  level: number;
  xpLine: string;
  rateLine?: string | null;
  bonusLine: string;
  description: string;
  progressLabel: string;
  progressPct: number;
  maxLevel: boolean;
  buttonLabel: string;
  buttonDisabled: boolean;
  requirements?: { xp: string; cost: string } | null;
  onLevelUp: () => void;
}) {
  return (
    <Card className="border-emerald-400/20 bg-ink/90 p-6">
      <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Account progression</div>
      <div className="mt-3 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <div>
          <div className="text-3xl font-semibold text-white">Level {level}</div>
          <div className="mt-2 text-sm text-zinc-300">{xpLine}</div>
          {rateLine ? <div className="mt-1 text-sm text-zinc-300">{rateLine}</div> : null}
          <div className="mt-1 text-sm text-zinc-300">{bonusLine}</div>
          <div className="mt-3 text-xs text-zinc-500">{description}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-[0.2em] text-zinc-400">Progress to next level</div>
          <div className="mt-3">
            <div className="relative h-3 w-full overflow-hidden rounded-full bg-white/5">
              <div
                className="h-full rounded-full bg-emerald-400/70"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="mt-2 text-[11px] text-zinc-500">
              {maxLevel ? "Max level reached" : progressLabel}
            </div>
          </div>
          <div className="mt-4">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={onLevelUp} disabled={buttonDisabled}>
                {buttonLabel}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  window.location.assign("https://x1factory.xyz/progression");
                }}
              >
                Costs &amp; bonuses
              </Button>
            </div>
            {requirements ? (
              <div className="mt-3 text-xs text-zinc-400">
                <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  Requirements
                </div>
                <div className="mt-1 text-sm text-zinc-200">XP: {requirements.xp}</div>
                <div className="text-sm text-zinc-200">Cost: {requirements.cost} MIND</div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
}
