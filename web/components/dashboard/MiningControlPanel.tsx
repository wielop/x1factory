"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDashboard } from "@/components/dashboard/DashboardContext";
import { formatTokenAmount } from "@/lib/format";

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
    anyActive,
    durationDays,
    setDurationDays,
    planOptions,
    emissionNotStarted,
    onDeposit,
    onClosePosition,
    busy,
    xntBalanceUi,
  } = useDashboard();

  const [amountUi, setAmountUi] = useState("");

  const selectedPlan = planOptions.find((opt) => opt.d === durationDays);

  useEffect(() => {
    if (selectedPlan) setAmountUi(selectedPlan.price);
  }, [selectedPlan]);

  const primaryPosition = useMemo(() => {
    const withLock = positions.filter((p) => p.data.lockedAmount > 0n);
    return withLock[0] ?? null;
  }, [positions]);

  const lockEnded =
    primaryPosition &&
    nowTs != null &&
    primaryPosition.data.lockedAmount > 0n &&
    nowTs >= primaryPosition.data.lockEndTs;

  const buyDisabledReason = useMemo(() => {
    if (!publicKey) return "Connect wallet first.";
    if (emissionNotStarted) return "Mining not started yet.";
    if (busy) return "Transaction pending.";
    if (!config) return "Config loading.";
    if (!selectedPlan) return "Select a plan.";
    if (amountUi && amountUi !== selectedPlan.price) return "Amount must match plan price.";
    return null;
  }, [amountUi, busy, config, emissionNotStarted, publicKey, selectedPlan]);

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
            {anyActive ? "Buy Miner" : "Start Mining"}
          </div>
        </div>
        <Badge variant={anyActive ? "success" : "muted"}>{anyActive ? "active" : "inactive"}</Badge>
      </div>

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
                <div className="mt-1 text-[11px] text-emerald-200">XP {opt.xp}</div>
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
          <div className="mt-6">
            <Button
              size="lg"
              onClick={() => void onDeposit().catch(() => null)}
              disabled={!!buyDisabledReason}
            >
              {busy === "buy" ? "Submitting…" : "BUY MINER"}
            </Button>
          </div>
          {buyDisabledReason ? (
            <div className="text-xs text-amber-200">{buyDisabledReason}</div>
          ) : null}
          <div className="text-[11px] text-zinc-500">
            Deposit is non-refundable. Each miner is a separate position.
          </div>
        </div>
      </div>

      {lockEnded ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="rounded-3xl border border-white/5 bg-white/5 p-4">
            <div className="text-xs text-zinc-400">Unlock ready</div>
            <div className="mt-2 text-2xl font-semibold text-white">Withdraw available</div>
            <div className="mt-2 text-xs text-zinc-500">Close the position to clear it from your wallet.</div>
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
          </div>
        </div>
      ) : null}
    </Card>
  );
}
