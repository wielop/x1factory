"use client";

import { useState, useEffect, useCallback } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { Connection, Transaction } from "@solana/web3.js";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { BEDROCK_RPC_URL, CLAIM_TIERS, costForHpLamports, LAMPORTS_PER_XNT } from "@/lib/bedrock/constants";

type StateResponse = {
  vein: { seasonId: string; reserveTotal: string; reserveRemaining: string; endTs: string };
  config: { networkHpActive: string; currentBaseRate: string; halvingEra: number };
  profile: {
    activeHp: string;
    activeClaimCount: number;
    nextPositionIndex: string;
    level: number;
    xp: string;
  } | null;
  positions: {
    index: number;
    tier: number;
    hp: string;
    startTs: string;
    endTs: string;
    deactivated: boolean;
    expired: boolean;
  }[];
};

function fmtXnt(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_XNT;
  const frac = lamports % LAMPORTS_PER_XNT;
  const fracStr = frac.toString().padStart(9, "0").slice(0, 3);
  return `${whole}.${fracStr}`;
}

function fmtDate(ts: string): string {
  const n = Number(ts);
  if (!n) return "-";
  return new Date(n * 1000).toLocaleString();
}

const connection = new Connection(BEDROCK_RPC_URL, "confirmed");

export default function BedrockMiningPage() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { setVisible } = useWalletModal();

  const [state, setState] = useState<StateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [tierIndex, setTierIndex] = useState(2); // Deep Vein domyslnie
  const [hpInput, setHpInput] = useState<string>(String(CLAIM_TIERS[2].refHp));
  const [status, setStatus] = useState<{ type: "idle" | "loading" | "success" | "error"; msg?: string }>({
    type: "idle",
  });

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const url = publicKey ? `/api/bedrock/mining/state?owner=${publicKey.toBase58()}` : "/api/bedrock/mining/state";
      const res = await fetch(url);
      const json = await res.json();
      if (res.ok) setState(json);
    } finally {
      setLoading(false);
    }
  }, [publicKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const tier = CLAIM_TIERS[tierIndex];
  const requestedHp = BigInt(Math.max(0, Math.floor(Number(hpInput) || 0)));
  const belowMin = requestedHp < BigInt(tier.refHp);
  const cost = requestedHp > 0n ? costForHpLamports(tierIndex, requestedHp) : 0n;

  async function submit(action: "buy_claim" | "claim_ore", extra: Record<string, unknown>) {
    if (!publicKey) {
      setVisible(true);
      return;
    }
    setStatus({ type: "loading" });
    try {
      const res = await fetch("/api/bedrock/mining/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, owner: publicKey.toBase58(), ...extra }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error ?? "Prepare failed");

      const tx = Transaction.from(Buffer.from(json.transaction, "base64"));
      const sig = await sendTransaction(tx, connection);
      await connection.confirmTransaction(
        { signature: sig, blockhash: tx.recentBlockhash!, lastValidBlockHeight: json.lastValidBlockHeight },
        "confirmed"
      );
      setStatus({ type: "success", msg: `Gotowe. Tx: ${sig.slice(0, 12)}…` });
      refresh();
    } catch (e: unknown) {
      setStatus({ type: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  }

  const purityBps =
    state && BigInt(state.vein.reserveTotal) > 0n
      ? Number((BigInt(state.vein.reserveRemaining) * 10000n) / BigInt(state.vein.reserveTotal))
      : 0;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Mining — Bedrock (testnet)</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Kup Roszczenie, wydobywaj ORE. Zyla sezonu {state ? `#${state.vein.seasonId}` : "…"}, czystość{" "}
          {(purityBps / 100).toFixed(2)}%.
        </p>
      </div>

      {status.type !== "idle" && (
        <div
          className={
            "rounded-xl border px-4 py-3 text-sm " +
            (status.type === "error"
              ? "border-rose-500/30 bg-rose-500/10 text-rose-100"
              : status.type === "success"
                ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100"
                : "border-cyan-400/20 bg-ink/60 text-zinc-300")
          }
        >
          {status.type === "loading" ? "Wysyłanie transakcji…" : status.msg}
        </div>
      )}

      <Card>
        <CardHeader title="Kup Roszczenie" description="Wybierz tier i ilość HP (moc wydobywcza)." />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
          {CLAIM_TIERS.map((t, i) => (
            <button
              key={t.index}
              onClick={() => {
                setTierIndex(i);
                setHpInput(String(t.refHp));
              }}
              className={
                "rounded-xl border p-3 text-left transition " +
                (i === tierIndex
                  ? "border-cyan-300/60 bg-cyan-400/10"
                  : "border-white/10 bg-ink/50 hover:border-cyan-300/30")
              }
            >
              <div className="text-sm font-semibold text-white">{t.name}</div>
              <div className="text-xs text-zinc-400">{t.durationDays} dni</div>
              <div className="text-xs text-zinc-400">min {t.refHp} HP</div>
              <div className="text-xs text-cyan-300 mt-1">{t.refCostXnt} XNT / {t.refHp} HP</div>
            </button>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-zinc-400">HP (min {tier.refHp})</span>
            <input
              type="number"
              value={hpInput}
              onChange={(e) => setHpInput(e.target.value)}
              min={tier.refHp}
              className="h-10 w-32 rounded-lg border border-white/10 bg-ink/70 px-3 text-white outline-none focus:border-cyan-300/50"
            />
          </label>
          <div className="text-sm text-zinc-300">
            Koszt: <span className="text-white font-semibold">{fmtXnt(cost)} XNT</span>
          </div>
          <Button
            onClick={() => submit("buy_claim", { tier: tierIndex, requestedHp: requestedHp.toString() })}
            disabled={belowMin || status.type === "loading"}
          >
            {connected ? "Kup Roszczenie" : "Połącz portfel"}
          </Button>
        </div>
        {belowMin && (
          <p className="text-xs text-amber-300 mt-2">
            Minimum dla tieru {tier.name} to {tier.refHp} HP (bariera kapitałowa — bez tego każdy kupowałby
            najtańszą stawkę).
          </p>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Twoje pozycje"
          description={state?.profile ? `active_hp: ${state.profile.activeHp}, poziom: ${state.profile.level + 1}` : "Połącz portfel, żeby zobaczyć pozycje."}
        />
        {!connected && (
          <div className="mt-3">
            <Button onClick={() => setVisible(true)}>Połącz portfel</Button>
          </div>
        )}
        {connected && loading && <p className="text-sm text-zinc-400 mt-3">Ładowanie…</p>}
        {connected && !loading && (!state?.positions || state.positions.length === 0) && (
          <p className="text-sm text-zinc-400 mt-3">Brak pozycji — kup pierwsze Roszczenie powyżej.</p>
        )}
        <div className="mt-3 space-y-2">
          {state?.positions.map((p) => {
            const now = Date.now() / 1000;
            const isExpired = Number(p.endTs) <= now;
            return (
              <div
                key={p.index}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-ink/50 p-3"
              >
                <div>
                  <div className="text-sm text-white">
                    #{p.index} · {CLAIM_TIERS[p.tier]?.name ?? `tier ${p.tier}`} · {p.hp} HP
                  </div>
                  <div className="text-xs text-zinc-400">
                    {p.deactivated ? "zdeaktywowana" : isExpired ? "wygasła" : `do ${fmtDate(p.endTs)}`}
                  </div>
                </div>
                {!p.deactivated && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => submit("claim_ore", { positionIndex: p.index })}
                    disabled={status.type === "loading"}
                  >
                    Odbierz ORE
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </main>
  );
}
