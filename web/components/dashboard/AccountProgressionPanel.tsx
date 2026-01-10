"use client";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export function AccountProgressionPanel({
  level,
  xpLine,
  rateLine,
  bonusLine,
  yieldLine,
  yieldActionLabel,
  yieldActionDisabled,
  onYieldAction,
  yieldMetaLine,
  yieldLinkHref,
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
  yieldLine?: string | null;
  yieldActionLabel?: string | null;
  yieldActionDisabled?: boolean;
  onYieldAction?: () => void;
  yieldMetaLine?: string | null;
  yieldLinkHref?: string | null;
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
          {yieldLine ? <div className="mt-1 text-sm text-zinc-300">{yieldLine}</div> : null}
          {yieldMetaLine ? (
            <div className="mt-1 text-[11px] text-zinc-400">{yieldMetaLine}</div>
          ) : null}
          {yieldActionLabel ? (
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={onYieldAction}
              disabled={yieldActionDisabled}
            >
              {yieldActionLabel}
            </Button>
          ) : null}
          {yieldLinkHref ? (
            <a
              href={yieldLinkHref}
              className="mt-2 inline-flex text-xs font-semibold text-emerald-200 hover:text-emerald-100"
            >
              View yield details
            </a>
          ) : null}
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
            <Button size="sm" onClick={onLevelUp} disabled={buttonDisabled}>
              {buttonLabel}
            </Button>
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
