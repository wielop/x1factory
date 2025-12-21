"use client";

import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDashboard } from "@/components/dashboard/DashboardContext";
import { formatDurationSeconds, formatTokenAmount, formatUnixTs } from "@/lib/format";
import { getCurrentEpochFrom } from "@/lib/solana";

export function MiningActivityPanel() {
  const {
    config,
    activePositions,
    positions,
    nowTs,
    busy,
    publicKey,
    onClaim,
    nextEpochCountdown,
    estimatedRewardBase,
    currentEpoch,
  } = useDashboard();

  const rewardForDurationBase = (durationDays: number) => {
    if (!config) return null;
    if (durationDays === 7) return BigInt(config.mindReward7d.toString());
    if (durationDays === 14) return BigInt(config.mindReward14d.toString());
    if (durationDays === 28 || durationDays === 30) return BigInt(config.mindReward28d.toString());
    return null;
  };

  const rewardPerEpochBase = (durationDays: number) => {
    const total = rewardForDurationBase(durationDays);
    if (total == null || durationDays <= 0) return null;
    return total / BigInt(durationDays);
  };

  const claimableForPosition = (durationDays: number, lockStartTs: number, lockEndTs: number, lastClaimedEpoch: bigint) => {
    if (!config || currentEpoch == null || currentEpoch < 0) return 0;
    const startEpoch = getCurrentEpochFrom(config, lockStartTs);
    const endEpoch = getCurrentEpochFrom(config, lockEndTs);
    const effectiveLast = Math.max(Number(lastClaimedEpoch), startEpoch);
    const cappedNow = Math.min(currentEpoch, endEpoch);
    return Math.max(0, cappedNow - effectiveLast);
  };

  const claimablePositions = positions.filter((pos) => pos.data.lockedAmount > 0n);
  const claimableTotalBase = claimablePositions.reduce((acc, pos) => {
    const perEpoch = rewardPerEpochBase(pos.data.durationDays);
    if (perEpoch == null) return acc;
    const epochs = claimableForPosition(
      pos.data.durationDays,
      pos.data.lockStartTs,
      pos.data.lockEndTs,
      pos.data.lastClaimedEpoch
    );
    return acc + perEpoch * BigInt(epochs);
  }, 0n);

  const claimDisabledReason = !publicKey
    ? "Connect wallet."
    : !config || currentEpoch == null
      ? "Epoch data unavailable."
    : !claimablePositions.length
      ? "No miners."
      : claimableTotalBase <= 0n
        ? "Nothing accrued yet."
        : busy
          ? "Transaction pending."
          : null;

  const sortedMiners = [...activePositions].sort((a, b) =>
    a.data.lockedAmount > b.data.lockedAmount ? -1 : a.data.lockedAmount < b.data.lockedAmount ? 1 : 0
  );
  const visibleMiners = sortedMiners.slice(0, 2);
  const extraMiners = sortedMiners.slice(2);
  const epochProgress =
    config && nextEpochCountdown
      ? Math.max(
          0,
          Math.min(1, 1 - nextEpochCountdown.seconds / Math.max(1, config.epochSeconds.toNumber()))
        )
      : 0;
  const topMiner = sortedMiners[0];
  const lockProgress = topMiner && nowTs != null
    ? Math.max(
        0,
        Math.min(
          1,
          (nowTs - topMiner.data.lockStartTs) /
            Math.max(1, topMiner.data.lockEndTs - topMiner.data.lockStartTs)
        )
      )
    : 0;

  return (
    <Card className="border-cyan-400/20 bg-ink/90">
      <CardHeader
        title="Active Miners"
        description="Current mining activity and quick actions."
        right={<Badge variant={activePositions.length ? "success" : "muted"}>{activePositions.length} active</Badge>}
      />

      <div className="mt-5 grid gap-5 lg:grid-cols-[2fr_1fr]">
        <div className="grid gap-3">
          {activePositions.length === 0 ? (
            <div className="rounded-3xl border border-white/5 bg-white/5 p-5 text-sm text-zinc-300">
              <div className="flex items-center gap-3">
                <svg
                  className="h-6 w-6 text-cyan-200"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M12 2l9 5-9 5-9-5 9-5z" />
                  <path d="M3 12l9 5 9-5" />
                </svg>
                <div>
                  Brak aktywnych minerów – zacznij już teraz, wybierając plan powyżej.
                </div>
              </div>
            </div>
          ) : (
            <>
              {visibleMiners.map((pos) => {
              const remaining =
                nowTs != null ? Math.max(0, pos.data.lockEndTs - nowTs) : null;
              const perMinerDaily = rewardPerEpochBase(pos.data.durationDays);
              const totalReward = rewardForDurationBase(pos.data.durationDays);
              return (
                <div
                  key={pos.pubkey}
                  className="rounded-3xl border border-white/5 bg-white/5 p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-white">
                      {config
                        ? `${formatTokenAmount(pos.data.lockedAmount, config.xntDecimals, 4)} XNT`
                        : "—"}
                    </div>
                    <Badge variant="success">active</Badge>
                  </div>
                  <div className="mt-2 text-xs text-zinc-400">
                    Paid{" "}
                    <span className="font-mono text-zinc-200">
                      {config
                        ? `${formatTokenAmount(pos.data.lockedAmount, config.xntDecimals, 4)} XNT`
                        : "—"}
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-zinc-400">
                    Ends at{" "}
                    <span className="font-mono text-zinc-200">
                      {formatUnixTs(pos.data.lockEndTs)}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Remaining{" "}
                    <span className="font-mono text-zinc-200">
                      {remaining != null ? formatDurationSeconds(remaining) : "—"}
                    </span>
                  </div>
                  <div className="mt-2 text-xs text-zinc-400">
                    Est. daily{" "}
                    <span className="font-mono text-zinc-200">
                      {config && perMinerDaily != null
                        ? `${formatTokenAmount(perMinerDaily, config.mindDecimals, 4)} MIND`
                        : "—"}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-zinc-400">
                    Est. total{" "}
                    <span className="font-mono text-zinc-200">
                      {config && totalReward != null
                        ? `${formatTokenAmount(totalReward, config.mindDecimals, 4)} MIND`
                        : "—"}
                    </span>
                  </div>
                </div>
              );
            })}
              {extraMiners.length > 0 ? (
                <details className="group rounded-3xl border border-white/5 bg-white/5 p-4">
                  <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.2em] text-zinc-300">
                    Show all miners ({extraMiners.length})
                  </summary>
                  <div className="mt-3 grid gap-3">
                    {extraMiners.map((pos) => {
                      const remaining =
                        nowTs != null ? Math.max(0, pos.data.lockEndTs - nowTs) : null;
                      const perMinerDaily = rewardPerEpochBase(pos.data.durationDays);
                      const totalReward = rewardForDurationBase(pos.data.durationDays);
                      return (
                        <div
                          key={pos.pubkey}
                          className="rounded-3xl border border-white/5 bg-black/20 p-4"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="text-sm font-semibold text-white">
                              {config
                                ? `${formatTokenAmount(pos.data.lockedAmount, config.xntDecimals, 4)} XNT`
                                : "—"}
                            </div>
                            <Badge variant="success">active</Badge>
                          </div>
                          <div className="mt-2 text-xs text-zinc-400">
                            Ends at{" "}
                            <span className="font-mono text-zinc-200">
                              {formatUnixTs(pos.data.lockEndTs)}
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-zinc-400">
                            Remaining{" "}
                            <span className="font-mono text-zinc-200">
                              {remaining != null ? formatDurationSeconds(remaining) : "—"}
                            </span>
                          </div>
                          <div className="mt-2 text-xs text-zinc-400">
                            Est. daily{" "}
                            <span className="font-mono text-zinc-200">
                              {config && perMinerDaily != null
                                ? `${formatTokenAmount(perMinerDaily, config.mindDecimals, 4)} MIND`
                                : "—"}
                            </span>
                          </div>
                          <div className="mt-1 text-xs text-zinc-400">
                            Est. total{" "}
                            <span className="font-mono text-zinc-200">
                              {config && totalReward != null
                                ? `${formatTokenAmount(totalReward, config.mindDecimals, 4)} MIND`
                                : "—"}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </details>
              ) : null}
            </>
          )}
        </div>

        <div className="rounded-3xl border border-white/5 bg-white/5 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs text-zinc-400">Epoch actions</div>
              <div className="mt-2 text-xs text-zinc-400">
                Next epoch in{" "}
                <span className="font-mono text-zinc-200">
                  {nextEpochCountdown ? formatDurationSeconds(nextEpochCountdown.seconds) : "—"}
                </span>
              </div>
              <div className="mt-2 text-xs text-zinc-400">
                Next epoch reward{" "}
                <span className="font-mono text-zinc-200">
                  {config && estimatedRewardBase != null
                    ? `${formatTokenAmount(estimatedRewardBase, config.mindDecimals, 4)} MIND`
                    : "—"}
                </span>
              </div>
            </div>
            <div className="flex items-center justify-center">
              <svg viewBox="0 0 120 120" className="h-20 w-20">
                <circle cx="60" cy="60" r="50" stroke="rgba(255,255,255,0.08)" strokeWidth="10" fill="none" />
                <circle
                  cx="60"
                  cy="60"
                  r="50"
                  stroke="rgba(34,242,255,0.7)"
                  strokeWidth="10"
                  fill="none"
                  strokeDasharray={`${Math.round(epochProgress * 314)} 314`}
                  strokeLinecap="round"
                  transform="rotate(-90 60 60)"
                />
                <text x="60" y="66" textAnchor="middle" className="fill-zinc-200 text-[12px]">
                  {Math.round(epochProgress * 100)}%
                </text>
              </svg>
            </div>
          </div>
          <div className="mt-4">
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
              Locked XNT → MIND reward
            </div>
            <div className="mt-2 h-2 w-full rounded-full bg-white/5">
              <div className="h-2 rounded-full bg-cyan-300/70" style={{ width: `${lockProgress * 100}%` }} />
            </div>
          </div>
          <div className="mt-4 grid gap-3">
            <Button
              size="lg"
              variant="primary"
              onClick={() => void onClaim().catch(() => null)}
              disabled={!!claimDisabledReason}
            >
              {busy === "claim" ? "Submitting…" : "CLAIM"}
            </Button>
            <div className="text-xs text-zinc-400">
              Claimable now{" "}
              <span className="font-mono text-zinc-200">
                {config ? `${formatTokenAmount(claimableTotalBase, config.mindDecimals, 4)} MIND` : "—"}
              </span>
            </div>
            {claimDisabledReason ? (
              <div className="text-xs text-amber-200">{claimDisabledReason}</div>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
}
