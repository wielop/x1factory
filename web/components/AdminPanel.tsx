"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { Card, Field, Button, Input } from "@/components/Ui";
import {
  deriveConfigPda,
  fetchClockUnixTs,
  fetchConfig,
  getCurrentEpochFrom,
} from "@/lib/solana";
import { getProgram } from "@/lib/anchor";

export function AdminPanel() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();

  const [config, setConfig] = useState<Awaited<ReturnType<typeof fetchConfig>> | null>(null);
  const [nowTs, setNowTs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [th1, setTh1] = useState("10000000000"); // 10 XNT @ 9 dec
  const [th2, setTh2] = useState("40000000000"); // 40 XNT @ 9 dec
  const [mpCapBps, setMpCapBps] = useState("200");
  const [updateEpochSeconds, setUpdateEpochSeconds] = useState(false);
  const [epochSeconds, setEpochSeconds] = useState("86400");

  const refresh = useCallback(async () => {
    setError(null);
    const cfg = await fetchConfig(connection);
    setConfig(cfg);
    const ts = await fetchClockUnixTs(connection);
    setNowTs(ts);
  }, [connection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const currentEpoch = useMemo(() => {
    if (!config || nowTs == null) return null;
    return getCurrentEpochFrom(config, nowTs);
  }, [config, nowTs]);

  const isAdmin =
    !!publicKey && !!config && publicKey.toBase58() === config.admin.toBase58();

  const submit = async () => {
    if (!publicKey) throw new Error("Connect wallet");
    if (!anchorWallet) throw new Error("Wallet is not ready for Anchor");
    if (!config) throw new Error("Config not loaded");
    if (!isAdmin) throw new Error("Connected wallet is not the admin");
    setBusy(true);
    setLastSig(null);
    setError(null);
    try {
      const program = getProgram(connection, anchorWallet);
      const sig = await program.methods
        .adminUpdateConfig({
          th1: new BN(th1),
          th2: new BN(th2),
          mpCapBpsPerWallet: Number(mpCapBps),
          updateEpochSeconds,
          epochSeconds: new BN(epochSeconds),
        })
        .accounts({
          admin: publicKey,
          config: deriveConfigPda(),
        })
        .rpc();
      setLastSig(sig);
      await refresh();
    } catch (e: any) {
      setError(String(e?.message ?? e));
      throw e;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-4">
      <Card title="Config">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Config PDA" value={deriveConfigPda().toBase58()} />
          <Field label="Admin" value={config?.admin.toBase58() ?? "(loading)"} />
          <Field label="Epoch seconds" value={config ? config.epochSeconds.toString() : "(loading)"} />
          <Field label="Current epoch" value={currentEpoch ?? "(loading)"} />
        </div>
        <div className="mt-3">
          <Button onClick={() => void refresh()} disabled={busy}>
            Refresh
          </Button>
        </div>
      </Card>

      <Card title="Admin update">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid gap-2">
            <div className="text-xs text-zinc-400">THRESHOLD_1 (base units)</div>
            <Input value={th1} onChange={setTh1} />
          </div>
          <div className="grid gap-2">
            <div className="text-xs text-zinc-400">THRESHOLD_2 (base units)</div>
            <Input value={th2} onChange={setTh2} />
          </div>
          <div className="grid gap-2">
            <div className="text-xs text-zinc-400">mp_cap_bps_per_wallet</div>
            <Input value={mpCapBps} onChange={setMpCapBps} />
          </div>
          <div className="grid gap-2">
            <div className="text-xs text-zinc-400">epoch_seconds</div>
            <Input value={epochSeconds} onChange={setEpochSeconds} />
            <label className="flex items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={updateEpochSeconds}
                onChange={(e) => setUpdateEpochSeconds(e.target.checked)}
              />
              update epoch_seconds (requires allow flag)
            </label>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button disabled={!isAdmin || busy} onClick={() => void submit()}>
            {busy ? "Working..." : "Submit admin_update_config"}
          </Button>
          <div className="text-xs text-zinc-400">
            {publicKey ? (isAdmin ? "admin connected" : "not admin") : "connect wallet"}
          </div>
        </div>

        {lastSig ? (
          <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs">
            last tx: {lastSig}
          </div>
        ) : null}
        {error ? (
          <div className="mt-4 rounded-lg border border-red-900/60 bg-red-950/40 p-3 text-sm text-red-200">
            {error}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
