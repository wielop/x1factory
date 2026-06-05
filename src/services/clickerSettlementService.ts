import { Connection, PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import type { ClickerClaim, Wallet } from "@prisma/client";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { createDetectedEvent, findDetectedEvent } from "../db/eventRepository.js";
import { prisma } from "../db/prisma.js";
import { getWalletScannerCursor, upsertWalletScannerCursor } from "../db/scannerRepository.js";
import { settlePendingClickerClaimById } from "./clickerService.js";

const DEFAULT_RPC_URL = "https://rpc.mainnet.x1.xyz";
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const PARSED_TRANSACTION_BATCH_SIZE = 10;

type ClickerSettlementScanSummary = {
  walletsScanned: number;
  topUpsDetected: number;
  claimsSettled: number;
  errors: number;
  message: string;
};

type TopUpMatch = {
  txHash: string;
  slot: number;
  blockTime: Date | null;
  amountMicro: bigint;
};

function deriveAssociatedTokenAccountAddress(owner: string, mint: string): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), new PublicKey(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0].toBase58();
}

function toDate(blockTime?: number | null): Date | null {
  return typeof blockTime === "number" ? new Date(blockTime * 1000) : null;
}

function accountKeyAt(parsed: ParsedTransactionWithMeta, index: number): string | null {
  const accountKey = parsed.transaction.message.accountKeys[index];

  if (!accountKey) {
    return null;
  }

  if (typeof accountKey === "string") {
    return accountKey;
  }

  const rawPubkey = (accountKey as unknown as { pubkey?: unknown }).pubkey;

  if (typeof rawPubkey === "string") {
    return rawPubkey;
  }

  const pubkey = rawPubkey as { toBase58?: () => string } | undefined;
  if (pubkey && typeof pubkey.toBase58 === "function") {
    return pubkey.toBase58();
  }

  return null;
}

async function getParsedTransactionsInBatches(
  connection: Connection,
  signatures: string[]
): Promise<Array<ParsedTransactionWithMeta | null>> {
  const results: Array<ParsedTransactionWithMeta | null> = [];

  for (let start = 0; start < signatures.length; start += PARSED_TRANSACTION_BATCH_SIZE) {
    const batch = signatures.slice(start, start + PARSED_TRANSACTION_BATCH_SIZE);
    const parsedBatch = await connection.getParsedTransactions(batch, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0
    });

    results.push(...parsedBatch);
  }

  return results;
}

function extractIncomingXntAmount(
  parsed: ParsedTransactionWithMeta,
  ownerWallet: string,
  ataAddress: string,
  xntMint: string
): bigint {
  const preBalances = new Map<string, bigint>();

  for (const balance of parsed.meta?.preTokenBalances ?? []) {
    if (balance.mint !== xntMint) {
      continue;
    }

    preBalances.set(`${balance.accountIndex}:${balance.mint}`, BigInt(balance.uiTokenAmount.amount));
  }

  let total = 0n;

  for (const balance of parsed.meta?.postTokenBalances ?? []) {
    if (balance.mint !== xntMint) {
      continue;
    }

    const accountKey = accountKeyAt(parsed, balance.accountIndex);
    const matchesOwner = balance.owner === ownerWallet;
    const matchesAta = accountKey === ataAddress;

    if (!matchesOwner && !matchesAta) {
      continue;
    }

    const preAmount = preBalances.get(`${balance.accountIndex}:${balance.mint}`) ?? 0n;
    const postAmount = BigInt(balance.uiTokenAmount.amount);
    const delta = postAmount - preAmount;

    if (delta > 0n) {
      total += delta;
    }
  }

  return total;
}

async function inspectIncomingTopUps(params: {
  walletAddress: string;
  xntMint: string;
  sinceSlot?: number;
  notBefore?: Date | null;
}): Promise<{ topUps: TopUpMatch[]; currentSlot: number | null }> {
  const connection = new Connection(env.x1RpcUrl ?? DEFAULT_RPC_URL, "confirmed");
  const ownerKey = new PublicKey(params.walletAddress);
  const ataAddress = deriveAssociatedTokenAccountAddress(params.walletAddress, params.xntMint);

  const [ownerSignatures, ataSignatures] = await Promise.all([
    connection.getSignaturesForAddress(ownerKey, { limit: 100 }, "confirmed"),
    connection.getSignaturesForAddress(new PublicKey(ataAddress), { limit: 100 }, "confirmed")
  ]);

  const merged = new Map<string, { signature: string; slot: number; blockTime: Date | null }>();

  for (const entry of [...ownerSignatures, ...ataSignatures]) {
    if (entry.err) {
      continue;
    }

    if (params.sinceSlot != null && entry.slot <= params.sinceSlot) {
      continue;
    }

    const existing = merged.get(entry.signature);
    const candidate = {
      signature: entry.signature,
      slot: entry.slot,
      blockTime: toDate(entry.blockTime)
    };

    if (!existing || candidate.slot > existing.slot) {
      merged.set(entry.signature, candidate);
    }
  }

  const signatures = Array.from(merged.values()).sort((left, right) => left.slot - right.slot);
  const currentSlot = signatures.length > 0 ? signatures[signatures.length - 1]?.slot ?? null : null;

  if (signatures.length === 0) {
    return { topUps: [], currentSlot };
  }

  const parsedTransactions = await getParsedTransactionsInBatches(
    connection,
    signatures.map((entry) => entry.signature)
  );

  const topUps: TopUpMatch[] = [];

  for (let index = 0; index < signatures.length; index += 1) {
    const signature = signatures[index];
    const parsed = parsedTransactions[index];

    if (!parsed) {
      continue;
    }

    if (params.notBefore && signature.blockTime && signature.blockTime < params.notBefore) {
      continue;
    }

    const amountMicro = extractIncomingXntAmount(parsed, params.walletAddress, ataAddress, params.xntMint);

    if (amountMicro <= 0n) {
      continue;
    }

    topUps.push({
      txHash: signature.signature,
      slot: signature.slot,
      blockTime: signature.blockTime,
      amountMicro
    });
  }

  return { topUps, currentSlot };
}

export async function scanAndSettlePendingClickerClaims(): Promise<ClickerSettlementScanSummary> {
  if (!env.xntMint) {
    return {
      walletsScanned: 0,
      topUpsDetected: 0,
      claimsSettled: 0,
      errors: 0,
      message: "XNT mint not configured"
    };
  }

  const now = new Date();
  const pendingClaims = (await prisma.clickerClaim.findMany({
    where: {
      paymentStatus: "PENDING",
      expiresAt: {
        gt: now
      },
    },
    include: {
      clickerWallet: true
    },
    orderBy: {
      createdAt: "asc"
    }
  })) as Array<ClickerClaim & { clickerWallet: Wallet }>;

  if (pendingClaims.length === 0) {
    return {
      walletsScanned: 0,
      topUpsDetected: 0,
      claimsSettled: 0,
      errors: 0,
      message: "No pending clicker claims"
    };
  }

  const claimsByWallet = new Map<number, typeof pendingClaims>();

  for (const claim of pendingClaims) {
    const walletId = claim.clickerWalletId;
    if (!walletId || !claim.clickerWallet) {
      continue;
    }

    const bucket = claimsByWallet.get(walletId) ?? [];
    bucket.push(claim);
    claimsByWallet.set(walletId, bucket);
  }

  let walletsScanned = 0;
  let topUpsDetected = 0;
  let claimsSettled = 0;
  let errors = 0;

  for (const [walletId, claims] of claimsByWallet.entries()) {
    const clickerWallet = claims[0]?.clickerWallet;

    if (!clickerWallet) {
      continue;
    }

    walletsScanned += 1;

    const cursor = await getWalletScannerCursor(walletId);
    const sinceSlot = cursor?.lastSlot != null ? Number(cursor.lastSlot) : undefined;
    const claimBoundary = claims.reduce<Date | null>((earliest, claim) => {
      if (!earliest) {
        return claim.createdAt;
      }

      return claim.createdAt < earliest ? claim.createdAt : earliest;
    }, null);

    let scanResult: Awaited<ReturnType<typeof inspectIncomingTopUps>>;

    try {
      scanResult = await inspectIncomingTopUps({
        walletAddress: clickerWallet.address,
        xntMint: env.xntMint,
        sinceSlot,
        notBefore: claimBoundary
      });
    } catch (error) {
      errors += 1;
      logger.warn({ error, wallet: clickerWallet.address }, "Clicker funding wallet scan failed");
      continue;
    }

    topUpsDetected += scanResult.topUps.length;

    let advancedCursor = scanResult.topUps.length === 0;

    for (const topUp of scanResult.topUps) {
      const claim = claims.find((entry) => entry.paymentStatus === "PENDING");

      if (!claim) {
        advancedCursor = true;
        break;
      }

      if (topUp.blockTime && claim.createdAt > topUp.blockTime) {
        continue;
      }

      try {
        const settled = await settlePendingClickerClaimById({
          claimId: claim.id,
          paymentTxHash: topUp.txHash,
          payoutTxHash: null
        });

        claimsSettled += 1;
        advancedCursor = true;

        const existingEvent = await findDetectedEvent({
          txHash: topUp.txHash,
          eventType: "clicker_xnt_topup",
          walletId: clickerWallet.id
        });

        if (!existingEvent) {
          await createDetectedEvent({
            txHash: topUp.txHash,
            eventType: "clicker_xnt_topup",
            walletId: clickerWallet.id,
            seasonId: claim.seasonId,
            blockNumber: BigInt(topUp.slot),
            occurredAt: topUp.blockTime ?? new Date(),
            rawData: {
              clickerWalletId: clickerWallet.id,
              claimId: claim.id,
              amountMicro: topUp.amountMicro.toString(),
              paymentTxHash: topUp.txHash,
              payoutTxHash: settled.payoutTxHash
            } as never
          });
        }
      } catch (error) {
        logger.warn(
          {
            error,
            claimId: claim.id,
            wallet: clickerWallet.address,
            txHash: topUp.txHash
          },
          "Clicker claim settlement failed"
        );
        errors += 1;
      }
    }

    if (advancedCursor && scanResult.currentSlot != null) {
      await upsertWalletScannerCursor({
        walletId,
        lastSlot: scanResult.currentSlot,
        snapshot: {
          clickerSettlement: true,
          scannedAt: new Date().toISOString()
        },
        scannedAt: new Date()
      });
    }
  }

  return {
    walletsScanned,
    topUpsDetected,
    claimsSettled,
    errors,
    message: "Clicker funding wallet scan completed"
  };
}
