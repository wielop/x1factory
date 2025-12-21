"use client";

import { useMemo } from "react";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDashboard } from "@/components/dashboard/DashboardContext";
import { STAKE_DURATIONS } from "@/components/dashboard/constants";
import { formatDurationSeconds, formatTokenAmount, formatUnixTs } from "@/lib/format";

const STAKING_COOLDOWN_SECONDS = 7 * 86_400;

function estimateStakeRewardParts(args: {
  amountBase: bigint;
  boostBps: number;
  durationDays: number;
  totalWeighted: bigint;
  vaultBase: bigint;
}) {
  const { amountBase, boostBps, durationDays, totalWeighted, vaultBase } = args;
  if (amountBase <= 0n || totalWeighted <= 0n || vaultBase <= 0n) return null;
  const durationMult =
    durationDays === 7 ? 10_000n : durationDays === 14 ? 11_000n : durationDays === 30 ? 12_500n : 15_000n;
  const baseWeight = (amountBase * durationMult) / 10_000n;
  const boostedWeight = (baseWeight * BigInt(10_000 + boostBps)) / 10_000n;
  const base = (vaultBase * baseWeight) / totalWeighted;
  const boosted = (vaultBase * boostedWeight) / totalWeighted;
  return { base, boosted };
}

export function StakeSection() {
  const {
    publicKey,
    config,
    nowTs,
    stakingPositions,
    stakingVaultXntBalanceBase,
    stakingVaultXntBalanceUi,
    stakeAmountUi,
    setStakeAmountUi,
    stakeDurationDays,
    setStakeDurationDays,
    handleStakeMax,
    stakeEstimate,
    onStake,
    onClaimStake,
    onWithdrawStake,
    busy,
    rewardPoolSeries,
    mindBalanceUi,
  } = useDashboard();

  const totalWeighted = useMemo(() => (config ? BigInt(config.totalStakedMind.toString()) : 0n), [config]);
  const stakeDisabledReason = useMemo(() => {
    if (!publicKey) return "Connect wallet.";
    if (!config) return "Config loading.";
    if (!stakeAmountUi) return "Enter amount.";
    if (busy) return "Transaction pending.";
    return null;
  }, [busy, config, publicKey, stakeAmountUi]);

  return (
    <Card>
      <CardHeader
        title="Stake MIND"
        description="Lock MIND to earn a share of the XNT rewards pool."
        right={<Badge variant="muted">Pool: {stakingVaultXntBalanceUi ?? "—"} XNT</Badge>}
      />

      {!publicKey ? (
        <div className="mt-4 text-sm text-zinc-400">Connect wallet to stake and view rewards.</div>
      ) : (
        <div className="mt-4 grid gap-4">
          <div className="rounded-3xl border border-white/5 bg-white/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-xs text-zinc-400">Stake MIND</div>
                <div className="mt-1 text-sm text-zinc-300">
                  Balance <span className="font-mono text-zinc-200">{mindBalanceUi ?? "—"} MIND</span>
                </div>
              </div>
              <Badge variant="muted">Pool {stakingVaultXntBalanceUi ?? "—"} XNT</Badge>
            </div>
            <div className="mt-4 grid gap-3">
              <Input
                value={stakeAmountUi}
                onChange={setStakeAmountUi}
                placeholder="Amount (MIND)"
                disabled={busy !== null}
                right={
                  <button
                    type="button"
                    className="rounded-full border border-cyan-300/30 px-2 py-1 text-[10px] text-cyan-100"
                    onClick={handleStakeMax}
                  >
                    Max
                  </button>
                }
              />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {STAKE_DURATIONS.map((days) => (
                  <button
                    key={days}
                    type="button"
                    onClick={() => setStakeDurationDays(days)}
                    className={[
                      "rounded-2xl border px-3 py-2 text-sm transition",
                      stakeDurationDays === days
                        ? "border-cyan-300/50 bg-cyan-300/10 text-white"
                        : "border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10",
                    ].join(" ")}
                  >
                    {days}d
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-zinc-400">
                  Est. pool share{" "}
                  <span className="font-mono text-zinc-200">
                    {config && stakeEstimate?.boosted != null
                      ? `${formatTokenAmount(stakeEstimate.boosted, config.xntDecimals, 4)} XNT`
                      : "—"}
                  </span>
                </div>
                <Button
                  size="lg"
                  onClick={() => void onStake().catch(() => null)}
                  disabled={!!stakeDisabledReason}
                >
                  {busy === "stake" ? "Submitting…" : "Stake MIND"}
                </Button>
              </div>
              {stakeDisabledReason ? (
                <div className="text-xs text-amber-200">{stakeDisabledReason}</div>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3">
            {stakingPositions.length === 0 ? (
              <div className="rounded-3xl border border-white/5 bg-white/5 p-4 text-sm text-zinc-400">
                No active stakes yet.
              </div>
            ) : (
              stakingPositions.map((stake) => {
                const lockEndTs = stake.data.lockEndTs;
                const amount = stake.data.amount;
                const rewardEstimate =
                  config && stakingVaultXntBalanceBase != null
                    ? estimateStakeRewardParts({
                        amountBase: amount,
                        boostBps: stake.data.xpBoostBps,
                        durationDays: stake.data.durationDays,
                        totalWeighted,
                        vaultBase: stakingVaultXntBalanceBase,
                      })
                    : null;
                const claimReady =
                  nowTs != null && nowTs >= stake.data.lastClaimTs + STAKING_COOLDOWN_SECONDS;
                const nextClaimIn =
                  nowTs != null
                    ? Math.max(0, stake.data.lastClaimTs + STAKING_COOLDOWN_SECONDS - nowTs)
                    : null;
                const unlocked = nowTs != null && nowTs >= lockEndTs;
                const claimLabel = `claim-stake-${stake.pubkey}`;
                const withdrawLabel = `withdraw-stake-${stake.pubkey}`;
                const claimDisabledReason = claimReady
                  ? null
                  : busy
                    ? "Transaction pending."
                    : !publicKey
                      ? "Connect wallet."
                      : "Claim available once per 7 days.";
                const withdrawDisabledReason = unlocked
                  ? null
                  : busy
                    ? "Transaction pending."
                    : "Lock not ended.";

                return (
                  <div key={stake.pubkey} className="rounded-3xl border border-cyan-400/10 bg-ink/80 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-white">
                        {config ? `${formatTokenAmount(amount, config.mindDecimals, 4)} MIND` : "—"}
                      </div>
                      <Badge variant={unlocked ? "success" : "warning"}>{unlocked ? "unlocked" : "locked"}</Badge>
                    </div>
                    <div className="mt-2 text-xs text-zinc-400">
                      Duration: <span className="font-mono text-zinc-200">{stake.data.durationDays}d</span>
                    </div>
                    <div className="mt-1 text-xs text-zinc-400">
                      Ends: <span className="font-mono text-zinc-200">{formatUnixTs(lockEndTs)}</span>
                    </div>
                    <div className="mt-2 text-xs text-zinc-400">
                      Next claim:{" "}
                      <span className="font-mono text-zinc-200">
                        {claimReady ? "ready" : nextClaimIn != null ? formatDurationSeconds(nextClaimIn) : "—"}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-zinc-400">
                      Est. pool share:{" "}
                      <span className="font-mono text-zinc-200">
                        {config && rewardEstimate?.boosted != null
                          ? `${formatTokenAmount(rewardEstimate.boosted, config.xntDecimals, 4)} XNT`
                          : "—"}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        onClick={() => void onClaimStake(stake).catch(() => null)}
                        disabled={busy !== null || !claimReady}
                      >
                        {busy === claimLabel ? "Submitting…" : "Claim"}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void onWithdrawStake(stake).catch(() => null)}
                        disabled={busy !== null || !unlocked}
                      >
                        {busy === withdrawLabel ? "Submitting…" : "Withdraw"}
                      </Button>
                    </div>
                    {claimDisabledReason ? (
                      <div className="mt-2 text-xs text-amber-200">{claimDisabledReason}</div>
                    ) : null}
                    {withdrawDisabledReason ? (
                      <div className="mt-1 text-xs text-amber-200">{withdrawDisabledReason}</div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          <div className="rounded-3xl border border-white/5 bg-white/5 p-4">
            <div className="text-xs text-zinc-400">Reward pool (24h)</div>
            {rewardPoolSeries ? (
              <svg viewBox="0 0 100 100" className="mt-2 h-16 w-full">
                <polyline
                  fill="none"
                  stroke="#22f2ff"
                  strokeWidth="2"
                  points={rewardPoolSeries.points}
                />
              </svg>
            ) : (
              <div className="mt-2 text-xs text-zinc-500">Collecting history…</div>
            )}
          </div>
        </div>
      )}

    </Card>
  );
}
