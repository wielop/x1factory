"use client";

import { Card } from "@/components/ui/card";
import { useDashboard } from "@/components/dashboard/DashboardContext";
import { formatTokenAmount } from "@/lib/format";

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <Card className="p-4">
      <div className="text-xl font-semibold text-white">{value}</div>
      <div className="mt-2 text-[10px] uppercase tracking-[0.2em] text-zinc-400">{label}</div>
    </Card>
  );
}

export function SummaryCards() {
  const {
    config,
    currentEpoch,
    stakingVaultXntBalanceUi,
    stakingVaultMindBalanceUi,
    positions,
    stakingPositions,
  } = useDashboard();

  const lockedTotal = config
    ? formatTokenAmount(
        positions.reduce((acc, p) => acc + p.data.lockedAmount, 0n),
        config.xntDecimals,
        4
      )
    : "—";
  const stakedTotal = config
    ? formatTokenAmount(
        stakingPositions.reduce((acc, p) => acc + p.data.amount, 0n),
        config.mindDecimals,
        4
      )
    : "—";

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <StatCard label="Current Epoch" value={currentEpoch == null ? "—" : String(currentEpoch)} />
      <StatCard
        label="Emission"
        value={
          config
            ? `${formatTokenAmount(BigInt(config.minedTotal.toString()), config.mindDecimals, 2)} / ${formatTokenAmount(
                BigInt(config.minedCap.toString()),
                config.mindDecimals,
                2
              )}`
            : "—"
        }
      />
      <StatCard label="Pool TVL" value={stakingVaultXntBalanceUi ? `${stakingVaultXntBalanceUi} XNT` : "—"} />
      <StatCard label="Total Staked" value={stakingVaultMindBalanceUi ? `${stakingVaultMindBalanceUi} MIND` : "—"} />
      <StatCard label="Your Locked XNT" value={lockedTotal !== "—" ? `${lockedTotal} XNT` : "—"} />
      <StatCard label="Your Staked MIND" value={stakedTotal !== "—" ? `${stakedTotal} MIND` : "—"} />
    </div>
  );
}
