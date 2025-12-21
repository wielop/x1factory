"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useDashboard } from "@/components/dashboard/DashboardContext";
import { formatDurationSeconds, formatTokenAmount, formatUnixTs } from "@/lib/format";

type PanelState = "empty" | "active" | "ended";

const PLAN_MULTS: Record<7 | 14 | 30, string> = {
  7: "1.0x",
  14: "1.25x",
  30: "1.5x",
};

export function MiningControlPanel() {
  const {
    publicKey,
    config,
    nowTs,
    positions,
    activePositions,
    anyActive,
    durationDays,
    setDurationDays,
    planOptions,
    emissionNotStarted,
    heartbeatDone,
    claimed,
    onDeposit,
    onHeartbeat,
    onClaim,
    onClosePosition,
    busy,
    currentEpoch,
    nextEpochCountdown,
    estimatedRewardBase,
    xntBalanceUi,
  } = useDashboard();

  const [amountUi, setAmountUi] = useState("");
  const [planModalOpen, setPlanModalOpen] = useState(false);

  const selectedPlan = planOptions.find((opt) => opt.d === durationDays);

  useEffect(() => {
    if (selectedPlan) setAmountUi(selectedPlan.price);
  }, [selectedPlan]);

  const primaryPosition = useMemo(() => {
    const withLock = positions.filter((p) => p.data.lockedAmount > 0n);
    return withLock[0] ?? null;
  }, [positions]);

  const panelState: PanelState = useMemo(() => {
    if (!primaryPosition) return "empty";
    if (nowTs == null) return "active";
    if (primaryPosition.data.lockedAmount > 0n && nowTs >= primaryPosition.data.lockEndTs) return "ended";
    return "active";
  }, [nowTs, primaryPosition]);

  const lockProgress = useMemo(() => {
    if (!primaryPosition || nowTs == null) return 0;
    const start = primaryPosition.data.lockStartTs;
    const end = primaryPosition.data.lockEndTs;
    if (end <= start) return 0;
    const elapsed = Math.min(end - start, Math.max(0, nowTs - start));
    return Math.min(100, Math.round((elapsed / (end - start)) * 100));
  }, [nowTs, primaryPosition]);

  const heartbeatStatus = heartbeatDone ? "done" : "ready";
  const claimStatus = claimed ? "claimed" : heartbeatDone ? "claimable" : "not-ready";
  const claimable = heartbeatDone && !claimed;

  const buyDisabledReason = useMemo(() => {
    if (!publicKey) return "Connect wallet first.";
    if (emissionNotStarted) return "Mining not started yet.";
    if (busy) return "Transaction pending.";
    if (!config) return "Config loading.";
    if (!selectedPlan) return "Select a plan.";
    if (amountUi && amountUi !== selectedPlan.price) return "Amount must match plan price.";
    return null;
  }, [amountUi, busy, config, emissionNotStarted, publicKey, selectedPlan]);

  const heartbeatDisabledReason = useMemo(() => {
    if (!publicKey) return "Connect wallet first.";
    if (!anyActive) return "No active miner.";
    if (heartbeatDone) return "Already done this epoch.";
    if (currentEpoch == null) return "Epoch unavailable.";
    if (busy) return "Transaction pending.";
    return null;
  }, [anyActive, busy, currentEpoch, heartbeatDone, publicKey]);

  const claimDisabledReason = useMemo(() => {
    if (!publicKey) return "Connect wallet first.";
    if (!anyActive) return "No active miner.";
    if (!heartbeatDone) return "Heartbeat required.";
    if (claimed) return "Already claimed.";
    if (busy) return "Transaction pending.";
    return null;
  }, [anyActive, busy, claimed, heartbeatDone, publicKey]);

  const withdrawDisabledReason = useMemo(() => {
    if (!publicKey) return "Connect wallet first.";
    if (!primaryPosition) return "No position.";
    if (busy) return "Transaction pending.";
    return null;
  }, [busy, primaryPosition, publicKey]);

  return (
    <Card className="border-cyan-400/20 bg-ink/90">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-400">Mining Control Panel</div>
          <div className="mt-2 text-2xl font-semibold text-white">
            {panelState === "empty" ? "Start Mining" : panelState === "ended" ? "Unlock Ready" : "Mining Active"}
          </div>
          {emissionNotStarted && config ? (
            <div className="mt-2 text-xs text-amber-200">
              Mining starts at {formatUnixTs(config.emissionStartTs.toNumber())}
            </div>
          ) : null}
        </div>
        <Badge variant={anyActive ? "success" : "muted"}>{anyActive ? "active" : "inactive"}</Badge>
      </div>

      {panelState === "empty" ? (
        <div className="mt-6 grid gap-5 lg:grid-cols-[2fr_1fr]">
          <div className="grid gap-4">
            <div className="text-xs text-zinc-400">Choose a plan</div>
            <div className="grid grid-cols-3 gap-2">
              {planOptions.map((opt) => (
                <button
                  key={opt.d}
                  type="button"
                  onClick={() => setDurationDays(opt.d)}
                  className={[
                    "rounded-2xl border px-3 py-3 text-left text-xs transition",
                    durationDays === opt.d
                      ? "border-cyan-300/50 bg-cyan-300/10 text-white"
                      : "border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10",
                  ].join(" ")}
                >
                  <div className="text-sm font-semibold">{opt.d}d</div>
                  <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                    {PLAN_MULTS[opt.d as 7 | 14 | 30]}
                  </div>
                  <div className="mt-2 text-xs text-cyan-200">{opt.price} XNT</div>
                </button>
              ))}
            </div>
            <div className="rounded-3xl border border-white/5 bg-white/5 p-4">
              <div className="flex items-center justify-between gap-2 text-xs text-zinc-400">
                <span>Balance</span>
                <span className="font-mono text-zinc-200">{xntBalanceUi ?? "—"} XNT</span>
              </div>
              <div className="mt-3">
                <Input
                  value={amountUi}
                  onChange={setAmountUi}
                  placeholder="Amount (XNT)"
                  disabled={!publicKey}
                  right={
                    <button
                      type="button"
                      className="rounded-full border border-cyan-300/30 px-2 py-1 text-[10px] text-cyan-100"
                      onClick={() => selectedPlan && setAmountUi(selectedPlan.price)}
                      disabled={!selectedPlan}
                    >
                      Max
                    </button>
                  }
                />
              </div>
            </div>
          </div>
          <div className="flex flex-col justify-between gap-3">
            <Button
              size="lg"
              onClick={() => void onDeposit().catch(() => null)}
              disabled={!!buyDisabledReason}
            >
              {busy === "buy" ? "Submitting…" : "BUY MINER"}
            </Button>
            {buyDisabledReason ? (
              <div className="text-xs text-amber-200">{buyDisabledReason}</div>
            ) : null}
            <div className="text-[11px] text-zinc-500">
              Deposit is non-refundable. Each miner is a separate position.
            </div>
          </div>
        </div>
      ) : null}

      {panelState === "active" ? (
        <div className="mt-6 grid gap-5 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-3xl border border-white/5 bg-white/5 p-4">
            <div className="text-xs text-zinc-400">Locked amount</div>
            <div className="mt-2 text-2xl font-semibold text-white">
              {config && primaryPosition
                ? `${formatTokenAmount(primaryPosition.data.lockedAmount, config.xntDecimals, 4)} XNT`
                : "—"}
            </div>
            <div className="mt-3 grid gap-2 text-xs text-zinc-400">
              <div>
                Ends:{" "}
                <span className="font-mono text-zinc-200">
                  {primaryPosition ? formatUnixTs(primaryPosition.data.lockEndTs) : "—"}
                </span>
              </div>
              <div>
                Countdown:{" "}
                <span className="font-mono text-zinc-200">
                  {primaryPosition && nowTs != null
                    ? formatDurationSeconds(Math.max(0, primaryPosition.data.lockEndTs - nowTs))
                    : "—"}
                </span>
              </div>
              <div>
                Current epoch: <span className="font-mono text-zinc-200">{currentEpoch ?? "—"}</span>
              </div>
              <div>
                Next epoch in{" "}
                <span className="font-mono text-zinc-200">
                  {nextEpochCountdown ? formatDurationSeconds(nextEpochCountdown.seconds) : "—"}
                </span>
              </div>
            </div>
            <div className="mt-4 h-2 w-full rounded-full bg-white/5">
              <div className="h-2 rounded-full bg-cyan-300/70" style={{ width: `${lockProgress}%` }} />
            </div>
          </div>
          <div className="rounded-3xl border border-white/5 bg-white/5 p-4">
            <div className="text-xs text-zinc-400">Actions</div>
            <div className="mt-3 grid gap-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-white">Heartbeat</div>
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                    {heartbeatStatus}
                  </div>
                </div>
                <Button
                  onClick={() => void onHeartbeat().catch(() => null)}
                  disabled={!!heartbeatDisabledReason}
                >
                  {busy === "heartbeat" ? "Submitting…" : "Heartbeat"}
                </Button>
              </div>
              {heartbeatDisabledReason ? (
                <div className="text-xs text-amber-200">{heartbeatDisabledReason}</div>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-white">Claim</div>
                  <div className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
                    {claimStatus}
                  </div>
                </div>
                <Button
                  variant={claimable ? "primary" : "secondary"}
                  onClick={() => void onClaim().catch(() => null)}
                  disabled={!!claimDisabledReason}
                >
                  {busy === "claim" ? "Submitting…" : "Claim"}
                </Button>
              </div>
              {claimDisabledReason ? (
                <div className="text-xs text-amber-200">{claimDisabledReason}</div>
              ) : null}
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold text-white">Buy new miner</div>
                  <div className="text-xs text-zinc-400">Open another position.</div>
                </div>
                <Button variant="secondary" onClick={() => setPlanModalOpen(true)}>
                  Buy
                </Button>
              </div>
              {config && estimatedRewardBase != null ? (
                <div className="text-xs text-zinc-400">
                  Est. reward{" "}
                  <span className="font-mono text-zinc-200">
                    {formatTokenAmount(estimatedRewardBase, config.mindDecimals, 4)} MIND
                  </span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {panelState === "ended" ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-3xl border border-white/5 bg-white/5 p-4">
            <div className="text-xs text-zinc-400">Lock ended</div>
            <div className="mt-2 text-2xl font-semibold text-white">Ready</div>
            <div className="mt-2 text-xs text-zinc-500">
              Close the position to clear it from your wallet.
            </div>
          </div>
          <div className="flex flex-col gap-3">
            <Button
              size="lg"
              onClick={() => primaryPosition && void onClosePosition(primaryPosition.pubkey).catch(() => null)}
              disabled={!!withdrawDisabledReason}
            >
              {busy === "close" ? "Submitting…" : "WITHDRAW XNT"}
            </Button>
            {withdrawDisabledReason ? (
              <div className="text-xs text-amber-200">{withdrawDisabledReason}</div>
            ) : null}
            <Button variant="secondary" onClick={() => setPlanModalOpen(true)}>
              Buy miner
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog
        open={planModalOpen}
        onOpenChange={setPlanModalOpen}
        title="Buy a new miner"
        description="Choose a plan and confirm the deposit."
        footer={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setPlanModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void onDeposit().catch(() => null)} disabled={!!buyDisabledReason}>
              {busy === "buy" ? "Submitting…" : "Buy miner"}
            </Button>
          </div>
        }
      >
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-2">
            {planOptions.map((opt) => (
              <button
                key={opt.d}
                type="button"
                onClick={() => setDurationDays(opt.d)}
                className={[
                  "rounded-2xl border px-3 py-3 text-left text-xs transition",
                  durationDays === opt.d
                    ? "border-cyan-300/50 bg-cyan-300/10 text-white"
                    : "border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10",
                ].join(" ")}
              >
                <div className="text-sm font-semibold">{opt.d}d</div>
                <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                  {PLAN_MULTS[opt.d as 7 | 14 | 30]}
                </div>
                <div className="mt-2 text-xs text-cyan-200">{opt.price} XNT</div>
              </button>
            ))}
          </div>
          <Input
            value={amountUi}
            onChange={setAmountUi}
            placeholder="Amount (XNT)"
            right={
              <button
                type="button"
                className="rounded-full border border-cyan-300/30 px-2 py-1 text-[10px] text-cyan-100"
                onClick={() => selectedPlan && setAmountUi(selectedPlan.price)}
                disabled={!selectedPlan}
              >
                Max
              </button>
            }
          />
          {buyDisabledReason ? <div className="text-xs text-amber-200">{buyDisabledReason}</div> : null}
        </div>
      </Dialog>
    </Card>
  );
}
