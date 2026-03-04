"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connection, PublicKey } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import { getMeltProgram } from "@/lib/melt";

type MeltSummaryPhase = "IDLE" | "LIVE" | "ENDED" | "FINALIZED";

type MeltSummaryState = {
  envReady: boolean;
  loading: boolean;
  error: string | null;
  phase: MeltSummaryPhase;
  roundSeq: bigint | null;
  capLamports: bigint | null;
  vialLamports: bigint | null;
  missingLamports: bigint | null;
  roundEndTs: number | null;
  vPayLamports: bigint | null;
  totalBurnLamports: bigint | null;
  userBurnedLamports: bigint | null;
  userEstimatedPayoutLamports: bigint | null;
  userClaimedPayoutLamports: bigint | null;
  userClaimed: boolean;
};

type UseMeltSummaryArgs = {
  publicKey: PublicKey | null;
  anchorWallet: AnchorWallet | null;
  pollMs?: number;
};

type ConfiguredMeltEnv = {
  rpcUrl: string;
  programId: PublicKey;
  mindMint: PublicKey;
};

const CONFIG_SEED = "melt_config";
const ROUND_SEED = "melt_round";
const USER_ROUND_SEED = "melt_user_round";

const EMPTY_STATE: MeltSummaryState = {
  envReady: false,
  loading: false,
  error: null,
  phase: "IDLE",
  roundSeq: null,
  capLamports: null,
  vialLamports: null,
  missingLamports: null,
  roundEndTs: null,
  vPayLamports: null,
  totalBurnLamports: null,
  userBurnedLamports: null,
  userEstimatedPayoutLamports: null,
  userClaimedPayoutLamports: null,
  userClaimed: false,
};

const readStatus = (status: Record<string, unknown> | null): string => {
  if (!status) return "";
  const key = Object.keys(status)[0];
  return key ? key.toLowerCase() : "";
};

const deriveConfigPda = (programId: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from(CONFIG_SEED)], programId)[0];

const deriveRoundPda = (programId: PublicKey, seq: bigint) => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(seq);
  return PublicKey.findProgramAddressSync([Buffer.from(ROUND_SEED), buf], programId)[0];
};

const deriveUserRoundPda = (programId: PublicKey, user: PublicKey, round: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from(USER_ROUND_SEED), user.toBuffer(), round.toBuffer()],
    programId
  )[0];

const parseConfiguredMeltEnv = (): ConfiguredMeltEnv | null => {
  const rpcUrl = (process.env.NEXT_PUBLIC_MELT_RPC_URL ?? "").trim();
  const programIdRaw = (process.env.NEXT_PUBLIC_MELT_PROGRAM_ID ?? "").trim();
  const mindMintRaw = (process.env.NEXT_PUBLIC_MIND_MINT ?? "").trim();
  if (!rpcUrl || !programIdRaw || !mindMintRaw) return null;
  try {
    const parsed = new URL(rpcUrl);
    if (parsed.protocol !== "https:") return null;
    return {
      rpcUrl,
      programId: new PublicKey(programIdRaw),
      mindMint: new PublicKey(mindMintRaw),
    };
  } catch {
    return null;
  }
};

export function useMeltSummary({ publicKey, anchorWallet, pollMs = 6000 }: UseMeltSummaryArgs) {
  const configuredEnv = useMemo(() => parseConfiguredMeltEnv(), []);
  const connection = useMemo<Connection | null>(() => {
    if (!configuredEnv) return null;
    return new Connection(configuredEnv.rpcUrl, "confirmed");
  }, [configuredEnv]);

  const readonlyWallet = useMemo(
    () => ({
      publicKey: PublicKey.default,
      signTransaction: async (tx: unknown) => tx as never,
      signAllTransactions: async (txs: unknown) => txs as never,
    }),
    []
  );

  const [state, setState] = useState<MeltSummaryState>(() => ({
    ...EMPTY_STATE,
    envReady: !!configuredEnv,
  }));
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!configuredEnv || !connection) {
      if (!mountedRef.current) return;
      setState({ ...EMPTY_STATE, envReady: false });
      return;
    }
    try {
      if (!mountedRef.current) return;
      setState((prev) => ({ ...prev, envReady: true, loading: true, error: null }));

      const program = getMeltProgram(connection, anchorWallet ?? (readonlyWallet as AnchorWallet));
      const configPda = deriveConfigPda(configuredEnv.programId);
      const configInfo = await connection.getAccountInfo(configPda, "confirmed");
      if (!configInfo) {
        if (!mountedRef.current) return;
        setState({
          ...EMPTY_STATE,
          envReady: true,
          loading: false,
          error: null,
        });
        return;
      }

      const cfg = await (program.account as any).meltConfig.fetch(configPda);
      const capLamports = BigInt(cfg.vaultCapLamports.toString());
      const vialLamports = BigInt(cfg.vialLamports.toString());
      const missingLamports = capLamports > vialLamports ? capLamports - vialLamports : 0n;

      const nextSeq = BigInt(cfg.roundSeq.toString());
      let roundPda: PublicKey | null = null;
      if (cfg.activeRoundActive) {
        const activeSeq = BigInt(cfg.activeRoundSeq.toString());
        roundPda = deriveRoundPda(configuredEnv.programId, activeSeq);
      } else if (nextSeq > 0n) {
        roundPda = deriveRoundPda(configuredEnv.programId, nextSeq - 1n);
      }

      let phase: MeltSummaryPhase = "IDLE";
      let roundSeq: bigint | null = null;
      let roundEndTs: number | null = null;
      let vPayLamports: bigint | null = null;
      let totalBurnLamports: bigint | null = 0n;
      let userBurnedLamports: bigint | null = publicKey ? 0n : null;
      let userEstimatedPayoutLamports: bigint | null = null;
      let userClaimedPayoutLamports: bigint | null = publicKey ? 0n : null;
      let userClaimed = false;
      let currentRoundTotalBurnLamports: bigint | null = null;

      if (roundPda) {
        const roundInfo = await connection.getAccountInfo(roundPda, "confirmed");
        if (roundInfo) {
          const round = await (program.account as any).meltRound.fetch(roundPda);
          const status = readStatus(round.status as Record<string, unknown>);
          roundSeq = BigInt(round.seq.toString());
          roundEndTs = Number(round.endTs.toString());
          vPayLamports = BigInt(round.vPay.toString());
          currentRoundTotalBurnLamports = BigInt(round.totalBurn.toString());
          const nowSec = Math.floor(Date.now() / 1000);
          if (status === "finalized") {
            phase = "FINALIZED";
          } else if (status === "active" && nowSec < roundEndTs) {
            phase = "LIVE";
          } else if (status === "active" && nowSec >= roundEndTs) {
            phase = "ENDED";
          }

          if (publicKey) {
            const userRoundPda = deriveUserRoundPda(configuredEnv.programId, publicKey, roundPda);
            const userRound = await (program.account as any).meltUserRound.fetchNullable(userRoundPda);
            if (userRound) {
              const userRoundBurnedLamports = BigInt(userRound.burned.toString());
              userClaimed = !!userRound.claimed;
              if (currentRoundTotalBurnLamports > 0n && vPayLamports != null) {
                userEstimatedPayoutLamports =
                  (vPayLamports * userRoundBurnedLamports) / currentRoundTotalBurnLamports;
              } else {
                userEstimatedPayoutLamports = 0n;
              }
            }
          }
        }
      }

      const roundAccounts = await connection.getProgramAccounts(configuredEnv.programId, {
        commitment: "confirmed",
        filters: [{ dataSize: 58 }],
      });
      let allRoundsBurn = 0n;
      const finalizedRoundMeta = new Map<string, { vPayLamports: bigint; totalBurnLamports: bigint }>();
      for (const entry of roundAccounts) {
        const data = entry.account.data;
        if (data.length < 58) continue;
        const totalBurnRound = data.readBigUInt64LE(48);
        allRoundsBurn += totalBurnRound;
        const status = data.readUInt8(56);
        if (status !== 2) continue;
        finalizedRoundMeta.set(entry.pubkey.toBase58(), {
          vPayLamports: data.readBigUInt64LE(40),
          totalBurnLamports: totalBurnRound,
        });
      }
      totalBurnLamports = allRoundsBurn;

      if (publicKey) {
        const userRoundAccounts = await connection.getProgramAccounts(configuredEnv.programId, {
          commitment: "confirmed",
          filters: [
            { dataSize: 82 },
            {
              memcmp: {
                offset: 8,
                bytes: publicKey.toBase58(),
              },
            },
          ],
        });
        let allUserBurned = 0n;
        let allUserClaimedPayout = 0n;
        for (const entry of userRoundAccounts) {
          const data = entry.account.data;
          if (data.length < 81) continue;
          const roundPk = new PublicKey(data.subarray(40, 72)).toBase58();
          const burned = data.readBigUInt64LE(72);
          const claimed = data.readUInt8(80) === 1;
          allUserBurned += burned;
          if (!claimed) continue;
          const roundMeta = finalizedRoundMeta.get(roundPk);
          if (!roundMeta || roundMeta.totalBurnLamports <= 0n) continue;
          allUserClaimedPayout += (roundMeta.vPayLamports * burned) / roundMeta.totalBurnLamports;
        }
        userBurnedLamports = allUserBurned;
        userClaimedPayoutLamports = allUserClaimedPayout;
      }

      if (!mountedRef.current) return;
      setState({
        envReady: true,
        loading: false,
        error: null,
        phase,
        roundSeq,
        capLamports,
        vialLamports,
        missingLamports,
        roundEndTs,
        vPayLamports,
        totalBurnLamports,
        userBurnedLamports,
        userEstimatedPayoutLamports,
        userClaimedPayoutLamports,
        userClaimed,
      });
    } catch (e) {
      if (!mountedRef.current) return;
      const message = e instanceof Error ? e.message : String(e);
      setState((prev) => ({
        ...prev,
        envReady: true,
        loading: false,
        error: message,
      }));
    }
  }, [anchorWallet, configuredEnv, connection, publicKey, readonlyWallet]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, pollMs);
    return () => window.clearInterval(id);
  }, [pollMs, refresh]);

  return {
    ...state,
    refresh,
  };
}
