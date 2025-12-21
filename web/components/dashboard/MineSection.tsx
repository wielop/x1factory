"use client";

import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useDashboard } from "@/components/dashboard/DashboardContext";
import { formatDurationSeconds, formatTokenAmount, shortPk } from "@/lib/format";
import { getProgramId, rpcUrl } from "@/lib/solana";

export function MineSection() {
  const {
    config,
    positions,
    currentEpoch,
    nextEpochCountdown,
    heartbeatDone,
    claimed,
    nowTs,
  } = useDashboard();

  return (
    <Card>
      <CardHeader
        title="Mining Details"
        description="On-chain status and advanced protocol details."
        right={
          <Badge variant={heartbeatDone ? "success" : claimed ? "muted" : "warning"}>
            {claimed ? "claimed" : heartbeatDone ? "ready" : "heartbeat"}
          </Badge>
        }
      />

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-3xl border border-white/5 bg-white/5 p-4">
          <div className="text-xs text-zinc-400">Current epoch</div>
          <div className="mt-2 text-lg font-semibold text-white">{currentEpoch ?? "—"}</div>
          <div className="mt-2 text-xs text-zinc-400">
            Next epoch in{" "}
            <span className="font-mono text-zinc-200">
              {nextEpochCountdown ? formatDurationSeconds(nextEpochCountdown.seconds) : "—"}
            </span>
          </div>
        </div>
        <div className="rounded-3xl border border-white/5 bg-white/5 p-4">
          <div className="text-xs text-zinc-400">Positions</div>
          <div className="mt-2 text-lg font-semibold text-white">{positions.length}</div>
          <div className="mt-2 text-xs text-zinc-500">Total mining positions.</div>
        </div>
      </div>

      <details className="group mt-5 rounded-3xl border border-white/5 bg-white/5 p-4">
        <summary className="cursor-pointer text-xs font-semibold uppercase tracking-[0.2em] text-zinc-300">
          Advanced / Details
        </summary>
        <div className="mt-4 grid gap-3 text-xs text-zinc-400">
          <div className="flex items-center justify-between">
            <span>RPC</span>
            <span className="font-mono text-zinc-200">{rpcUrl().replace(/^https?:\/\//, "")}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Program ID</span>
            <span className="font-mono text-zinc-200">{shortPk(getProgramId().toBase58(), 8)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Tier threshold 1</span>
            <span className="font-mono text-zinc-200">{config?.th1.toString() ?? "—"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>Tier threshold 2</span>
            <span className="font-mono text-zinc-200">{config?.th2.toString() ?? "—"}</span>
          </div>
          <div className="flex items-center justify-between">
            <span>MP cap per wallet</span>
            <span className="font-mono text-zinc-200">{config ? `${config.mpCapBpsPerWallet} bps` : "—"}</span>
          </div>
        </div>
        {positions.length > 0 ? (
          <div className="mt-4 grid gap-2 text-xs text-zinc-400">
            <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Positions list</div>
            {positions.slice(0, 5).map((p) => {
              const active = nowTs != null && p.data.lockedAmount > 0n && nowTs < p.data.lockEndTs;
              const ended = nowTs != null && p.data.lockedAmount > 0n && nowTs >= p.data.lockEndTs;
              return (
                <div
                  key={p.pubkey}
                  className="flex items-center justify-between gap-2 rounded-2xl border border-white/10 bg-white/5 px-3 py-2"
                >
                  <div className="font-mono text-[11px] text-zinc-300">{shortPk(p.pubkey, 8)}</div>
                  <div className="flex items-center gap-2">
                    <Badge variant={active ? "success" : ended ? "warning" : "muted"}>
                      {active ? "active" : ended ? "ended" : "inactive"}
                    </Badge>
                    <span className="font-mono text-[11px] text-zinc-400">
                      {config
                        ? `${formatTokenAmount(p.data.lockedAmount, config.xntDecimals, 4)} XNT`
                        : "—"}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </details>
    </Card>
  );
}
