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

      if (!mountedRef.current) return;
      setInitState("READY");
      setConfig(cfg);
      setRound(displayRound);
      setRoundPda(displayPda);
      setNextRoundPda(nextPda);
      setUserRound(fetchedUserRound);
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
    miningMeltConfig,
    roundStatus,
    isLive,
    isClaim,
    isRefreshing,
    error,
    refresh,
  };
}

