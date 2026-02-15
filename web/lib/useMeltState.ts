"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BN } from "@coral-xyz/anchor";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import {
  deriveMeltConfigPda,
  deriveMeltRoundPda,
  deriveMeltUserRoundPda,
  fetchMiningMeltConfig,
  getMeltProgramId,
  getMeltProgram,
} from "@/lib/melt";

export type MeltConfig = {
  admin: PublicKey;
  mindMint: PublicKey;
  vault: PublicKey;
  vaultCapLamports: BN;
  rolloverBps: number;
  burnMin: BN;
  roundWindowSec: BN;
  testMode: boolean;
  roundSeq: BN;
  vialLamports: BN;
  bonusPoolLamports: BN;
  activeRoundSeq: BN;
  activeRoundActive: boolean;
  pendingWindowSec: BN;
};

export type MeltRound = {
  seq: BN;
  startTs: BN;
  endTs: BN;
  vRound: BN;
  vPay: BN;
  totalBurn: BN;
  status: Record<string, unknown>;
};

export type MeltUserRound = {
  burned: BN;
  claimed: boolean;
};

export type MeltClaimContext = {
  round: MeltRound;
  roundPda: PublicKey;
  userRound: MeltUserRound | null;
};

export type MiningMeltConfig = {
  meltEnabled: boolean;
  meltProgramId: PublicKey;
  meltFundingBps: number;
};

export type MeltInitState = "READY" | "NOT_INITIALIZED";

type UseMeltStateArgs = {
  connection: Connection;
  anchorWallet: AnchorWallet | null;
  publicKey: PublicKey | null;
  pollMs?: number;
};

const readStatus = (status: Record<string, unknown> | null): string => {
  if (!status) return "";
  const key = Object.keys(status)[0];
  return key ? key.toLowerCase() : "";
};

export function useMeltState({ connection, anchorWallet, publicKey, pollMs = 4000 }: UseMeltStateArgs) {
  const readonlyWallet = useMemo(
    () => ({
      publicKey: PublicKey.default,
      signTransaction: async (tx: unknown) => tx as never,
      signAllTransactions: async (txs: unknown) => txs as never,
    }),
    []
  );

  const [initState, setInitState] = useState<MeltInitState>("READY");
  const [config, setConfig] = useState<MeltConfig | null>(null);
  const [round, setRound] = useState<MeltRound | null>(null);
  const [roundPda, setRoundPda] = useState<PublicKey | null>(null);
  const [nextRoundPda, setNextRoundPda] = useState<PublicKey | null>(null);
  const [userRound, setUserRound] = useState<MeltUserRound | null>(null);
  const [claimContext, setClaimContext] = useState<MeltClaimContext | null>(null);
  const [claimContexts, setClaimContexts] = useState<MeltClaimContext[]>([]);
  const [miningMeltConfig, setMiningMeltConfig] = useState<MiningMeltConfig | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      setIsRefreshing(true);
      const configPda = deriveMeltConfigPda();
      const configInfo = await connection.getAccountInfo(configPda, "confirmed");

      if (!configInfo) {
        if (!mountedRef.current) return;
        setInitState("NOT_INITIALIZED");
        setConfig(null);
        setRound(null);
        setRoundPda(null);
        setNextRoundPda(null);
        setUserRound(null);
        setClaimContext(null);
        setClaimContexts([]);
        setMiningMeltConfig(null);
        setError(null);
        return;
      }

      const program = getMeltProgram(connection, anchorWallet ?? (readonlyWallet as AnchorWallet));
      const cfg = (await program.account.meltConfig.fetch(configPda)) as MeltConfig;
      const miningCfg = (await fetchMiningMeltConfig(connection)) as MiningMeltConfig | null;
      const nextSeq = BigInt(cfg.roundSeq.toString());
      const nextPda = deriveMeltRoundPda(nextSeq);

      let displayRound: MeltRound | null = null;
      let displayPda: PublicKey | null = null;
      if (cfg.activeRoundActive) {
        const activeSeq = BigInt(cfg.activeRoundSeq.toString());
        const activePda = deriveMeltRoundPda(activeSeq);
        const activeInfo = await connection.getAccountInfo(activePda, "confirmed");
        if (activeInfo) {
          displayRound = (await program.account.meltRound.fetch(activePda)) as MeltRound;
          displayPda = activePda;
        }
      }
      if (!displayRound && nextSeq > 0n) {
        const lastSeq = nextSeq - 1n;
        const lastPda = deriveMeltRoundPda(lastSeq);
        const lastInfo = await connection.getAccountInfo(lastPda, "confirmed");
        if (lastInfo) {
          displayRound = (await program.account.meltRound.fetch(lastPda)) as MeltRound;
          displayPda = lastPda;
        }
      }

      let fetchedUserRound: MeltUserRound | null = null;
      if (publicKey && anchorWallet && displayPda) {
        const userProgram = getMeltProgram(connection, anchorWallet);
        const userRoundPda = deriveMeltUserRoundPda(publicKey, displayPda);
        fetchedUserRound = (await userProgram.account.meltUserRound.fetchNullable(
          userRoundPda
        )) as MeltUserRound | null;
      }

      let fetchedClaimContext: MeltClaimContext | null = null;
      const fetchedClaimContexts: MeltClaimContext[] = [];
      if (displayRound && displayPda && readStatus(displayRound.status) === "finalized") {
        fetchedClaimContext = {
          round: displayRound,
          roundPda: displayPda,
          userRound: fetchedUserRound,
        };
      }

      if (publicKey) {
        const meltProgramId = getMeltProgramId();
        const userRoundAccounts = await connection.getProgramAccounts(meltProgramId, {
          commitment: "confirmed",
          filters: [
            {
              memcmp: {
                offset: 8,
                bytes: publicKey.toBase58(),
              },
            },
          ],
        });

        for (const acc of userRoundAccounts) {
          const data = acc.account.data;
          if (data.length < 81) continue;
          const roundPk = new PublicKey(data.subarray(40, 72));
          const burned = data.readBigUInt64LE(72);
          const claimed = data.readUInt8(80) === 1;
          if (burned === 0n || claimed) continue;
          const roundInfo = await connection.getAccountInfo(roundPk, "confirmed");
          if (!roundInfo) continue;
          const rr = (await program.account.meltRound.fetch(roundPk)) as MeltRound;
          if (readStatus(rr.status) !== "finalized") continue;
          const ur: MeltUserRound = {
            burned: new BN(burned.toString()),
            claimed: false,
          };
          fetchedClaimContexts.push({ round: rr, roundPda: roundPk, userRound: ur });
        }
        fetchedClaimContexts.sort((a, b) => {
          const aa = BigInt(a.round.seq.toString());
          const bb = BigInt(b.round.seq.toString());
          return aa === bb ? 0 : aa < bb ? -1 : 1;
        });
        if (!fetchedClaimContext && fetchedClaimContexts.length > 0) {
          fetchedClaimContext = fetchedClaimContexts[0];
        }
      }

      if (!mountedRef.current) return;
      setInitState("READY");
      setConfig(cfg);
      setRound(displayRound);
      setRoundPda(displayPda);
      setNextRoundPda(nextPda);
      setUserRound(fetchedUserRound);
      setClaimContext(fetchedClaimContext);
      setClaimContexts(fetchedClaimContexts);
      setMiningMeltConfig(miningCfg);
      setError(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const missingConfig =
        message.includes("Account not found: meltConfig") ||
        message.includes("Account does not exist") ||
        message.includes("failed to get info about account") ||
        message.includes("Account data too small");
      if (missingConfig) {
        if (!mountedRef.current) return;
        setInitState("NOT_INITIALIZED");
        setConfig(null);
        setRound(null);
        setRoundPda(null);
        setNextRoundPda(null);
        setUserRound(null);
        setClaimContext(null);
        setClaimContexts([]);
        setMiningMeltConfig(null);
        setError(null);
        return;
      }
      if (!mountedRef.current) return;
      setError(message);
    } finally {
      if (mountedRef.current) {
        setIsRefreshing(false);
      }
    }
  }, [anchorWallet, connection, publicKey, readonlyWallet]);

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, pollMs);
    return () => window.clearInterval(id);
  }, [pollMs, refresh]);

  const roundStatus = readStatus(round?.status ?? null);
  const isLive = roundStatus === "active";
  const isClaim = roundStatus === "finalized";

  return {
    initState,
    config,
    round,
    roundPda,
    nextRoundPda,
    userRound,
    claimContext,
    claimContexts,
    miningMeltConfig,
    roundStatus,
    isLive,
    isClaim,
    isRefreshing,
    error,
    refresh,
  };
}
