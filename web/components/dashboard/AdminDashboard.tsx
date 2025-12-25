"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from "@solana/spl-token";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TopBar } from "@/components/shared/TopBar";
import { useToast } from "@/components/shared/ToastProvider";
import { getProgram } from "@/lib/anchor";
import {
  deriveConfigPda,
  deriveUserProfilePda,
  fetchClockUnixTs,
  fetchConfig,
} from "@/lib/solana";
import { formatTokenAmount, parseUiAmountToBase, shortPk } from "@/lib/format";
import { formatError } from "@/lib/formatError";

const DAY_SECONDS = 86_400n;

export function AdminDashboard() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const anchorWallet = useAnchorWallet();
  const { push: pushToast } = useToast();

  const [config, setConfig] = useState<Awaited<ReturnType<typeof fetchConfig>> | null>(null);
  const [nowTs, setNowTs] = useState<number | null>(null);
  const [mintDecimals, setMintDecimals] = useState<{ xnt: number; mind: number } | null>(null);
  const [stakingRewardBalance, setStakingRewardBalance] = useState<bigint>(0n);
  const [treasuryBalance, setTreasuryBalance] = useState<bigint>(0n);

  const [emissionPerDayUi, setEmissionPerDayUi] = useState<string>("");
  const [maxEffectiveHpUi, setMaxEffectiveHpUi] = useState<string>("");
  const [epochSecondsUi, setEpochSecondsUi] = useState<string>("86400");
  const [badgeUser, setBadgeUser] = useState<string>("");
  const [badgeTier, setBadgeTier] = useState<string>("0");
  const [badgeBonusBps, setBadgeBonusBps] = useState<string>("0");
  const [rewardTopUpUi, setRewardTopUpUi] = useState<string>("");

  const [busy, setBusy] = useState<string | null>(null);
  const [lastSig, setLastSig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const cfg = await fetchConfig(connection);
      setConfig(cfg);
      const ts = await fetchClockUnixTs(connection);
      setNowTs(ts);
      const [xntMintInfo, mindMintInfo] = await Promise.all([
        getMint(connection, cfg.xntMint, "confirmed"),
        getMint(connection, cfg.mindMint, "confirmed"),
      ]);
      setMintDecimals({ xnt: xntMintInfo.decimals, mind: mindMintInfo.decimals });
      const [rewardBal, treasuryBal] = await Promise.all([
        connection.getTokenAccountBalance(cfg.stakingRewardVault, "confirmed"),
        connection.getTokenAccountBalance(cfg.treasuryVault, "confirmed"),
      ]);
      setStakingRewardBalance(BigInt(rewardBal.value.amount || "0"));
      setTreasuryBalance(BigInt(treasuryBal.value.amount || "0"));
      if (mindMintInfo.decimals >= 0) {
        const emissionPerDay = (cfg.emissionPerSec * DAY_SECONDS) / 10n ** BigInt(mindMintInfo.decimals);
        setEmissionPerDayUi(emissionPerDay.toString());
      }
      setMaxEffectiveHpUi(cfg.maxEffectiveHp.toString());
    } catch (e: unknown) {
      console.error(e);
      setError(formatError(e));
    }
  }, [connection]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const isAdmin = useMemo(() => {
    if (!publicKey || !config) return false;
    return publicKey.equals(config.admin);
  }, [publicKey, config]);

  const withTx = async (label: string, fn: () => Promise<string>) => {
    setBusy(label);
    setError(null);
    try {
      const sig = await fn();
      setLastSig(sig);
      pushToast({ title: label, description: shortPk(sig, 6) });
    } catch (e: unknown) {
      console.error(e);
      setError(formatError(e));
    } finally {
      setBusy(null);
      await refresh();
    }
  };

  const onUpdateConfig = async () => {
    if (!anchorWallet || !config || !mintDecimals) return;
    let emissionPerSec: bigint;
    try {
      const perDayBase = parseUiAmountToBase(emissionPerDayUi, mintDecimals.mind);
      emissionPerSec = perDayBase / DAY_SECONDS;
    } catch (e: unknown) {
      setError(formatError(e));
      return;
    }
    let maxHp: bigint;
    try {
      maxHp = BigInt(maxEffectiveHpUi || "0");
    } catch {
      setError("Invalid max HP value");
      return;
    }
    if (emissionPerSec <= 0n || maxHp <= 0n) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Update config", async () => {
      const sig = await program.methods
        .adminUpdateConfig(new BN(emissionPerSec.toString()), new BN(maxHp.toString()))
        .accounts({
          admin: publicKey!,
          config: deriveConfigPda(),
        })
        .rpc();
      return sig;
    });
  };

  const onRollEpoch = async () => {
    if (!anchorWallet || !config) return;
    let seconds: bigint;
    try {
      seconds = BigInt(epochSecondsUi || "0");
    } catch {
      setError("Invalid epoch seconds");
      return;
    }
    if (seconds <= 0n) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Roll epoch", async () => {
      const sig = await program.methods
        .rollEpoch(new BN(seconds.toString()))
        .accounts({
          config: deriveConfigPda(),
          stakingRewardVault: config.stakingRewardVault,
        })
        .rpc();
      return sig;
    });
  };

  const onSetBadge = async () => {
    if (!anchorWallet || !config) return;
    let userPk: PublicKey;
    try {
      userPk = new PublicKey(badgeUser.trim());
    } catch {
      setError("Invalid user public key");
      return;
    }
    const tier = Number(badgeTier || 0);
    const bonus = Number(badgeBonusBps || 0);
    if (!Number.isFinite(tier) || !Number.isFinite(bonus)) {
      setError("Invalid badge inputs");
      return;
    }
    const program = getProgram(connection, anchorWallet);
    await withTx("Set badge", async () => {
      const sig = await program.methods
        .adminSetBadge(tier, bonus)
        .accounts({
          admin: publicKey!,
          config: deriveConfigPda(),
          user: userPk,
          userProfile: deriveUserProfilePda(userPk),
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      return sig;
    });
  };

  const onFundRewardVault = async () => {
    if (!anchorWallet || !config || !mintDecimals || !publicKey) return;
    let amountBase: bigint;
    try {
      amountBase = parseUiAmountToBase(rewardTopUpUi, mintDecimals.xnt);
    } catch (e: unknown) {
      setError(formatError(e));
      return;
    }
    if (amountBase <= 0n) return;
    const program = getProgram(connection, anchorWallet);
    await withTx("Fund reward vault", async () => {
      const tx = new Transaction();
      const adminAta = getAssociatedTokenAddressSync(config.xntMint, publicKey);
      const ataInfo = await connection.getAccountInfo(adminAta, "confirmed");
      if (!ataInfo) {
        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(
            publicKey,
            adminAta,
            publicKey,
            config.xntMint,
            TOKEN_PROGRAM_ID,
            ASSOCIATED_TOKEN_PROGRAM_ID
          )
        );
      }
      tx.add(
        createTransferInstruction(
          adminAta,
          config.stakingRewardVault,
          publicKey,
          amountBase,
          [],
          TOKEN_PROGRAM_ID
        )
      );
      return await program.provider.sendAndConfirm(tx, []);
    });
  };

  return (
    <div className="min-h-screen bg-ink text-white">
      <TopBar title="Mining V2 Admin" subtitle="Protocol controls" link={{ href: "/", label: "Dashboard" }} />

      <main className="mx-auto max-w-5xl px-4 pb-20 pt-10">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="p-4">
            <div className="text-sm font-semibold">Config</div>
            <div className="mt-3 text-xs text-zinc-400">
              Admin: {config ? shortPk(config.admin.toBase58(), 6) : "-"}
            </div>
            <div className="mt-2 text-xs text-zinc-400">
              Network HP: {config?.networkHpActive.toString() ?? "-"}
            </div>
            <div className="mt-2 text-xs text-zinc-400">
              Emission/sec: {config?.emissionPerSec.toString() ?? "-"} base
            </div>
            <div className="mt-2 text-xs text-zinc-400">
              Epoch end: {config?.stakingEpochEndTs ?? "-"}
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Badge variant={isAdmin ? "success" : "danger"}>{isAdmin ? "admin" : "readonly"}</Badge>
              <Badge variant="muted">Now {nowTs ?? "-"}</Badge>
            </div>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">Vaults</div>
            <div className="mt-3 text-xs text-zinc-400">
              Reward vault: {mintDecimals ? formatTokenAmount(stakingRewardBalance, mintDecimals.xnt, 4) : "-"} XNT
            </div>
            <div className="mt-2 text-xs text-zinc-400">
              Treasury vault: {mintDecimals ? formatTokenAmount(treasuryBalance, mintDecimals.xnt, 4) : "-"} XNT
            </div>
          </Card>
        </div>

        <section className="mt-8 grid gap-4 lg:grid-cols-2">
          <Card className="p-4">
            <div className="text-sm font-semibold">Update mining config</div>
            <div className="mt-3 text-xs text-zinc-400">Emission per day (MIND)</div>
            <Input value={emissionPerDayUi} onChange={setEmissionPerDayUi} />
            <div className="mt-3 text-xs text-zinc-400">Max effective HP</div>
            <Input value={maxEffectiveHpUi} onChange={setMaxEffectiveHpUi} />
            <Button className="mt-4" onClick={() => void onUpdateConfig()} disabled={!isAdmin || busy != null}>
              {busy === "Update config" ? "Submitting..." : "Update Config"}
            </Button>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">Roll staking epoch</div>
            <div className="mt-3 text-xs text-zinc-400">Epoch length (seconds)</div>
            <Input value={epochSecondsUi} onChange={setEpochSecondsUi} />
            <Button className="mt-4" onClick={() => void onRollEpoch()} disabled={busy != null}>
              {busy === "Roll epoch" ? "Submitting..." : "Roll Epoch"}
            </Button>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">Fund reward vault</div>
            <div className="mt-2 text-xs text-zinc-400">
              Send XNT from the admin wallet to the staking reward vault.
            </div>
            <div className="mt-3 text-xs text-zinc-400">Amount (XNT)</div>
            <Input value={rewardTopUpUi} onChange={setRewardTopUpUi} />
            <Button className="mt-4" onClick={() => void onFundRewardVault()} disabled={!isAdmin || busy != null}>
              {busy === "Fund reward vault" ? "Submitting..." : "Top up reward vault"}
            </Button>
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold">Set badge</div>
            <div className="mt-3 text-xs text-zinc-400">User pubkey</div>
            <Input value={badgeUser} onChange={setBadgeUser} />
            <div className="mt-3 text-xs text-zinc-400">Badge tier</div>
            <Input value={badgeTier} onChange={setBadgeTier} />
            <div className="mt-3 text-xs text-zinc-400">Bonus bps (cap 2000)</div>
            <Input value={badgeBonusBps} onChange={setBadgeBonusBps} />
            <Button className="mt-4" onClick={() => void onSetBadge()} disabled={!isAdmin || busy != null}>
              {busy === "Set badge" ? "Submitting..." : "Set Badge"}
            </Button>
          </Card>
        </section>

        {error ? <div className="mt-6 text-sm text-amber-200">{error}</div> : null}
        {lastSig ? (
          <div className="mt-4 text-xs text-zinc-400">
            Last tx: <span className="font-mono">{shortPk(lastSig, 8)}</span>
          </div>
        ) : null}
      </main>
    </div>
  );
}
