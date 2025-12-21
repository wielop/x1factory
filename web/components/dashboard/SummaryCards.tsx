"use client";

import { Card } from "@/components/ui/card";
import { useDashboard } from "@/components/dashboard/DashboardContext";
import { formatTokenAmount } from "@/lib/format";

function StatCard({
  label,
  value,
  description,
  highlight,
}: {
  label: string;
  value: string;
  description?: string;
  highlight?: boolean;
}) {
  return (
    <Card className={["p-4", highlight ? "border-cyan-400/30 bg-cyan-400/5" : ""].join(" ")}>
      <div className="text-xl font-semibold text-white">{value}</div>
      <div className="mt-2 text-[10px] uppercase tracking-[0.2em] text-zinc-400">{label}</div>
      {description ? <div className="mt-2 text-xs text-zinc-500">{description}</div> : null}
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
  const minedPercent = config
    ? Number(((BigInt(config.minedTotal.toString()) * 10_000n) / BigInt(config.minedCap.toString())).toString()) /
      100
    : null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <StatCard
        label="Current Epoch"
        value={currentEpoch == null ? "—" : String(currentEpoch)}
        description="Heartbeat to stay active."
      />
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
        description={
          minedPercent != null
            ? `Only ${minedPercent.toFixed(2)}% mined — dołącz zanim zabraknie!`
            : "MIND supply is limited."
        }
      />
      <StatCard
        label="Pool TVL"
        value={stakingVaultXntBalanceUi ? `${stakingVaultXntBalanceUi} XNT` : "—"}
        description="Rewards pool for stakers."
      />
      <StatCard
        label="Total Staked"
        value={stakingVaultMindBalanceUi ? `${stakingVaultMindBalanceUi} MIND` : "—"}
        description="Community locked in."
      />
      <StatCard
        label="Your Locked XNT"
        value={lockedTotal !== "—" ? `${lockedTotal} XNT` : "—"}
        description="Twoje aktywne wydobycie."
        highlight
      />
      <StatCard
        label="Your Staked MIND"
        value={stakedTotal !== "—" ? `${stakedTotal} MIND` : "—"}
        description="Twoje wzmocnienie nagród."
        highlight
      />
    </div>
  );
}
