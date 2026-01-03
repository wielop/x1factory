"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TopBar } from "@/components/shared/TopBar";
import { AdminNav } from "@/components/admin/AdminNav";
import { fetchConfig } from "@/lib/solana";
import { formatError } from "@/lib/formatError";
import type {
  AlertEntry,
  BurnStats,
  EconomicHealth,
  FlowStats,
  ProtocolSnapshot,
  TechnicalHealth,
} from "@/lib/adminData";

type AdminState = {
  snapshot: ProtocolSnapshot;
  flows: FlowStats[];
  alerts: AlertEntry[];
  health: { economic: EconomicHealth; technical: TechnicalHealth };
  burns: BurnStats;
};

const STAKING_SECONDS_PER_YEAR = 31_536_000;
const XNT_DECIMALS = 9;

const formatNumber = (value: number, digits = 0) =>
  Number.isFinite(value)
    ? value.toLocaleString("en-US", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })
    : "-";

const formatToken = (value: number, digits = 2) => formatNumber(value, digits);

const formatPercent = (value: number | null, digits = 2) =>
  value != null && Number.isFinite(value) ? `${formatNumber(value, digits)}%` : "-";

const formatTimestamp = (value: string | null) =>
  value ? new Date(value).toLocaleString() : "-";

const formatDateOnly = (value: string | null) =>
  value ? new Date(value).toLocaleDateString() : "-";

const healthStyles = {
  GREEN: "border-emerald-400/40 bg-emerald-400/10 text-emerald-100",
  YELLOW: "border-amber-300/40 bg-amber-300/10 text-amber-100",
  RED: "border-rose-400/40 bg-rose-400/10 text-rose-100",
} as const;

const impactBadge = (impact: number) =>
  impact >= 0 ? "text-emerald-200" : "text-rose-200";

const ImpactIcon = ({ impact }: { impact: number }) => (
  <span className={impactBadge(impact)}>{impact >= 0 ? "↑" : "↓"}</span>
);

// Expandable health card: shows summary + scoring breakdown.
function HealthCard({
  title,
  health,
}: {
  title: string;
  health: EconomicHealth | TechnicalHealth;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="p-4">
      <button type="button" onClick={() => setOpen((prev) => !prev)} className="w-full text-left">
        <div className="flex items-center gap-4">
          <div
            className={[
              "flex h-14 w-14 items-center justify-center rounded-full border text-lg font-semibold",
              healthStyles[health.state],
            ].join(" ")}
          >
            {Math.round(health.score)}
          </div>
          <div>
            <div className="text-xs uppercase tracking-[0.2em] text-zinc-400">{title}</div>
            <div className="mt-1 text-sm text-zinc-200">{health.summary}</div>
            <div className="mt-1 text-[11px] text-zinc-500">State: {health.state}</div>
          </div>
        </div>
      </button>
      {open ? (
        <div className="mt-4 space-y-2 text-xs text-zinc-300">
          {health.details.map((detail) => (
            <div key={detail.label} className="flex items-center justify-between gap-3">
              <div className="text-zinc-400">{detail.label}</div>
              <div className="flex items-center gap-2">
                <ImpactIcon impact={detail.impact} />
                <span className="text-zinc-200">{detail.value}</span>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  );
}

// Admin Data Center dashboard for protocol snapshot, flows, and alerts.
export function AdminDataDashboard() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [isAdmin, setIsAdmin] = useState(false);
  const [config, setConfig] = useState<Awaited<ReturnType<typeof fetchConfig>> | null>(null);
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [window, setWindow] = useState<FlowStats["window"]>("24h");

  const fetchState = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/admin/state", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`API error ${res.status}`);
      }
      const data = (await res.json()) as AdminState;
      setState(data);
    } catch (err) {
      setError(formatError(err));
    }
  }, []);

  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!publicKey) {
        setIsAdmin(false);
        setConfig(null);
        return;
      }
      try {
        const cfg = await fetchConfig(connection);
        if (!active) return;
        setConfig(cfg);
        setIsAdmin(cfg?.admin.equals(publicKey) ?? false);
      } catch {
        if (!active) return;
        setConfig(null);
        setIsAdmin(false);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [connection, publicKey]);

  useEffect(() => {
    if (!isAdmin) {
      setState(null);
      return;
    }
    void fetchState();
    const interval = setInterval(fetchState, 30_000);
    return () => clearInterval(interval);
  }, [fetchState, isAdmin]);

  const selectedFlow = useMemo(
    () => state?.flows.find((item) => item.window === window) ?? null,
    [state, window]
  );
  const stakingAprPct = useMemo(() => {
    if (!config || !state) return null;
    if (config.stakingRewardRateXntPerSec === 0n) return 0;
    const totalStaked = state.snapshot.staking.totalStakedMind;
    if (totalStaked <= 0) return 0;
    const rewardPerSec = Number(config.stakingRewardRateXntPerSec) / 10 ** XNT_DECIMALS;
    if (!Number.isFinite(rewardPerSec) || !Number.isFinite(totalStaked) || totalStaked <= 0) return null;
    const apr = (rewardPerSec * STAKING_SECONDS_PER_YEAR) / totalStaked;
    return apr * 100;
  }, [config, state]);
  const stakingApyPct = useMemo(() => {
    if (stakingAprPct == null) return null;
    const aprRate = stakingAprPct / 100;
    const apyRate = Math.pow(1 + aprRate / 365, 365) - 1;
    return apyRate * 100;
  }, [stakingAprPct]);

  const onResolve = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/alerts/${id}/resolve`, { method: "POST" });
      if (!res.ok) throw new Error(`Resolve failed (${res.status})`);
      await fetchState();
    } catch (err) {
      setError(formatError(err));
    }
  };

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-ink text-white">
        <TopBar link={{ href: "/", label: "Dashboard" }} />
        <main className="mx-auto max-w-6xl px-4 pb-20 pt-10">
          <Card className="mt-6 p-4 text-sm text-zinc-400">
            Connect with the admin wallet to view the Data Center.
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-ink text-white">
      <TopBar link={{ href: "/", label: "Dashboard" }} />

      <main className="mx-auto max-w-6xl px-4 pb-20 pt-10">
        <AdminNav active="data" isAdmin={isAdmin} />

        {state ? (
          <>
            {state.health.economic.state === "RED" || state.health.technical.state === "RED" ? (
              <Card className="mt-4 border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-100">
                Health is critical. Review the details below before making sensitive actions.
              </Card>
            ) : null}

            {/* Health overview cards for quick risk scanning. */}
            <section className="mt-6 grid gap-4 lg:grid-cols-2">
              <HealthCard title="Economic Health" health={state.health.economic} />
              <HealthCard title="Technical Health" health={state.health.technical} />
            </section>

            <section className="mt-6 grid gap-4 lg:grid-cols-3">
              <Card className="p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-400">
                  Mining snapshot
                </div>
                <div className="mt-3 space-y-2 text-sm text-zinc-200">
                  <div>Network HP: {formatNumber(state.snapshot.mining.networkHp)}</div>
                  <div>Max HP: {formatNumber(state.snapshot.mining.maxHp)}</div>
                  <div>
                    Daily emission: {formatToken(state.snapshot.mining.dailyEmissionMind)} MIND
                  </div>
                  <div>
                    Total mined: {formatToken(state.snapshot.mining.totalMindMined)} MIND
                  </div>
                </div>
              </Card>
              <Card className="p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-400">
                  Staking snapshot
                </div>
                <div className="mt-3 space-y-2 text-sm text-zinc-200">
                  <div>
                    Total staked: {formatToken(state.snapshot.staking.totalStakedMind)} MIND
                  </div>
                  <div>
                    Reward pool: {formatToken(state.snapshot.staking.rewardPoolXnt)} XNT
                  </div>
                  <div>APR: {formatPercent(stakingAprPct)}</div>
                  <div>APY: {formatPercent(stakingApyPct)}</div>
                  <div>Epoch ends: {formatTimestamp(state.snapshot.staking.epochEndsAt)}</div>
                </div>
              </Card>
              <Card className="p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-400">
                  Treasury snapshot
                </div>
                <div className="mt-3 space-y-2 text-sm text-zinc-200">
                  <div>Available: {formatToken(state.snapshot.treasury.available)} XNT</div>
                  <div>
                    In staking bucket: {formatToken(state.snapshot.treasury.inStakingBucket)} XNT
                  </div>
                  <div>In LP: {formatToken(state.snapshot.treasury.inLp)} XNT</div>
                  <div>Investments: {formatToken(state.snapshot.treasury.inInvestments)} XNT</div>
                  <div>Reserve: {formatToken(state.snapshot.treasury.inReserve)} XNT</div>
                </div>
              </Card>
            </section>

            <section className="mt-8">
              <div className="flex flex-wrap items-center gap-2">
                {(["24h", "7d", "30d"] as const).map((value) => (
                  <Button
                    key={value}
                    size="sm"
                    variant={window === value ? "primary" : "ghost"}
                    onClick={() => setWindow(value)}
                  >
                    {value}
                  </Button>
                ))}
              </div>
              <Card className="mt-4 p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-400">Flows</div>
                <div className="mt-3 grid gap-2 text-sm text-zinc-200">
                  <div>
                    XNT from mining: {selectedFlow ? formatToken(selectedFlow.xntFromMining) : "-"}
                  </div>
                  <div>
                    XNT to staking rewards:{" "}
                    {selectedFlow ? formatToken(selectedFlow.xntToStakingRewards) : "-"}
                  </div>
                  <div>
                    XNT to treasury: {selectedFlow ? formatToken(selectedFlow.xntToTreasury) : "-"}
                  </div>
                  <div>
                    XNT used for buyback: {selectedFlow ? formatToken(selectedFlow.xntUsedForBuyback) : "-"}
                  </div>
                  <div>
                    XNT added to LP: {selectedFlow ? formatToken(selectedFlow.xntAddedToLp) : "-"}
                  </div>
                </div>
              </Card>
            </section>

            <section className="mt-8">
              <Card className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-400">
                      Spalone MIND (unstake)
                    </div>
                    <div className="mt-1 text-sm text-zinc-200">
                      Wykluczone adresy: {state.burns.excludedOwners.join(", ")}
                    </div>
                  </div>
                  <div className="text-[11px] text-zinc-500">
                    Ostatnie zdarzenie: {formatTimestamp(state.burns.latestEventAt)}
                  </div>
                </div>
                <div className="mt-3 grid gap-1 text-sm text-zinc-200">
                  <div>
                    Łącznie unstake: {formatToken(state.burns.totalUnstakedMind, 3)} MIND
                  </div>
                  <div>
                    Łącznie spalone: {formatToken(state.burns.totalBurnedMind, 3)} MIND
                  </div>
                </div>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="text-xs uppercase tracking-[0.2em] text-zinc-400">
                      <tr className="border-b border-white/10">
                        <th className="py-2">Dzień (UTC)</th>
                        <th className="py-2">Unstake (MIND)</th>
                        <th className="py-2">Spalone (MIND)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {state.burns.days.length === 0 ? (
                        <tr>
                          <td className="py-2 text-xs text-zinc-500" colSpan={3}>
                            Brak zdarzeń unstake.
                          </td>
                        </tr>
                      ) : (
                        [...state.burns.days]
                          .sort((a, b) => (a.date > b.date ? -1 : 1))
                          .map((day) => (
                            <tr key={day.date}>
                              <td className="py-2 text-zinc-200">{formatDateOnly(day.date)}</td>
                              <td className="py-2 text-zinc-100">
                                {formatToken(day.unstakedMind, 3)}
                              </td>
                              <td className="py-2 text-emerald-200">
                                {formatToken(day.burnedMind, 3)}
                              </td>
                            </tr>
                          ))
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>
            </section>

            <section className="mt-8">
              <Card className="p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-400">Alerts</div>
                <div className="mt-3 space-y-3 text-sm text-zinc-200">
                  {state.alerts.length === 0 ? (
                    <div className="text-xs text-zinc-500">No alerts.</div>
                  ) : (
                    state.alerts.map((alert) => (
                      <div
                        key={alert.id}
                        className="rounded-xl border border-white/10 bg-white/5 p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div
                            className={[
                              "text-xs font-semibold uppercase tracking-[0.2em]",
                              alert.level === "CRITICAL"
                                ? "text-rose-200"
                                : alert.level === "WARN"
                                ? "text-amber-200"
                                : "text-zinc-300",
                            ].join(" ")}
                          >
                            {alert.level}
                          </div>
                          <div className="text-[11px] text-zinc-500">
                            {formatTimestamp(alert.createdAt)}
                          </div>
                        </div>
                        <div className="mt-2 text-sm text-white">{alert.message}</div>
                        {alert.details ? (
                          <div className="mt-1 text-xs text-zinc-500">{alert.details}</div>
                        ) : null}
                        <div className="mt-3 flex items-center gap-3 text-xs text-zinc-400">
                          <span>Resolved: {alert.resolved ? "Yes" : "No"}</span>
                          {!alert.resolved ? (
                            <button
                              type="button"
                              className="text-xs font-semibold uppercase tracking-[0.2em] text-emerald-200"
                              onClick={() => void onResolve(alert.id)}
                            >
                              Mark resolved
                            </button>
                          ) : null}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </Card>
            </section>
          </>
        ) : null}

        {error ? <div className="mt-6 text-sm text-amber-200">{error}</div> : null}
      </main>
    </div>
  );
}
