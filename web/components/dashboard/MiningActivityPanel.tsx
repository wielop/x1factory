"use client";

import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDashboard } from "@/components/dashboard/DashboardContext";
import { formatDurationSeconds, formatTokenAmount, formatUnixTs } from "@/lib/format";

export function MiningActivityPanel() {
  const {
    config,
    activePositions,
    nowTs,
    busy,
    publicKey,
    heartbeatDone,
    claimed,
    onHeartbeat,
    onClaim,
    nextEpochCountdown,
    estimatedRewardBase,
  } = useDashboard();

  const heartbeatDisabledReason = !publicKey
    ? "Connect wallet."
    : !activePositions.length
      ? "No active miners."
      : heartbeatDone
        ? "Already done."
        : busy
          ? "Transaction pending."
          : null;

  const claimDisabledReason = !publicKey
    ? "Connect wallet."
    : !activePositions.length
      ? "No active miners."
      : !heartbeatDone
        ? "Heartbeat required."
        : claimed
          ? "Already claimed."
          : busy
            ? "Transaction pending."
            : null;

  const visibleMiners = activePositions.slice(0, 2);
  const extraMiners = activePositions.slice(2);

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
            <div className="rounded-3xl border border-white/5 bg-white/5 p-4 text-sm text-zinc-400">
              No active miners yet.
            </div>
          ) : (
            <>
              {visibleMiners.map((pos) => {
              const remaining =
                nowTs != null ? Math.max(0, pos.data.lockEndTs - nowTs) : null;
              const perMinerDaily =
                estimatedRewardBase != null && activePositions.length > 0
                  ? estimatedRewardBase / BigInt(activePositions.length)
                  : null;
              const remainingDays =
                remaining != null ? BigInt(Math.max(1, Math.ceil(remaining / 86_400))) : null;
              const totalRemaining =
                perMinerDaily != null && remainingDays != null
                  ? perMinerDaily * remainingDays
                  : null;
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
                      {config && totalRemaining != null
                        ? `${formatTokenAmount(totalRemaining, config.mindDecimals, 4)} MIND`
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
                      const perMinerDaily =
                        estimatedRewardBase != null && activePositions.length > 0
                          ? estimatedRewardBase / BigInt(activePositions.length)
                          : null;
                      const remainingDays =
                        remaining != null ? BigInt(Math.max(1, Math.ceil(remaining / 86_400))) : null;
                      const totalRemaining =
                        perMinerDaily != null && remainingDays != null
                          ? perMinerDaily * remainingDays
                          : null;
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
                              {config && totalRemaining != null
                                ? `${formatTokenAmount(totalRemaining, config.mindDecimals, 4)} MIND`
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
          <div className="mt-4 grid gap-3">
            <Button
              size="lg"
              onClick={() => void onHeartbeat().catch(() => null)}
              disabled={!!heartbeatDisabledReason}
            >
              {busy === "heartbeat" ? "Submitting…" : "HEARTBEAT"}
            </Button>
            {heartbeatDisabledReason ? (
              <div className="text-xs text-amber-200">{heartbeatDisabledReason}</div>
            ) : null}
            <Button
              size="lg"
              variant={heartbeatDone && !claimed ? "primary" : "secondary"}
              onClick={() => void onClaim().catch(() => null)}
              disabled={!!claimDisabledReason}
            >
              {busy === "claim" ? "Submitting…" : "CLAIM"}
            </Button>
            {claimDisabledReason ? (
              <div className="text-xs text-amber-200">{claimDisabledReason}</div>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
}
