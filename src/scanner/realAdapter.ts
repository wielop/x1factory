import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  Connection,
  PublicKey,
  type ParsedInstruction,
  type ParsedTransactionWithMeta,
  type PartiallyDecodedInstruction
} from "@solana/web3.js";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

import {
  decodeAnchorEvent,
  decodeBuyContractArgs,
  decodeInstructionName,
  decodeMinerPositionAccountSafe,
  decodeStakeMindArgs,
  decodeUserMiningProfileAccount,
  decodeUserStakeAccount,
  isExpectedAccountDiscriminator,
  mindAtomicToDecimal,
  rigTypeFromIndex
} from "./anchorCodec.js";
import type {
  IX1FactoryAdapter,
  RigType,
  ScannerDiagnosticCandidate,
  ScannerDiagnostics,
  ScannerEventType,
  ScannerWalletResult,
  UserFactoryState,
  X1FactoryEvent
} from "./types.js";

type ParsedProgramArtifact = {
  idlPath: string;
  instructionNames: string[];
  parserConfirmed: boolean;
  parserMessage: string;
};

type PendingRenewal = {
  txHash: string;
  slot: number;
  blockTime: Date | null;
  positionAddress: string;
  raw: Record<string, unknown>;
};

const DEFAULT_RPC_URL = "https://rpc.mainnet.x1.xyz";
const DEFAULT_PROGRAM_ID = "uaDkkJGLLEY3kFMhhvrh5MZJ6fmwCmhNf8L7BZQJ9Aw";
const SUPPORTED_INSTRUCTIONS = ["buyContract", "renewRig", "renewRigWithBuff", "claimMind", "stakeMind"] as const;
const PARSED_TRANSACTION_BATCH_SIZE = 10;

function positionIndexSeed(index: number): Buffer {
  const seed = Buffer.alloc(8);
  seed.writeBigUInt64LE(BigInt(index));
  return seed;
}

function findIdlPath(): string | null {
  const configured = env.x1FactoryIdlPath ? resolve(process.cwd(), env.x1FactoryIdlPath) : null;
  const candidates = [
    configured,
    resolve(process.cwd(), "idl", "mining_v2.json"),
    resolve(process.cwd(), "../mining/target/idl/mining_v2.json"),
    resolve(process.cwd(), "../mining/web/idl/mining_v2.json")
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function loadProgramArtifact(): ParsedProgramArtifact {
  const idlPath = findIdlPath();

  if (!idlPath) {
    return {
      idlPath: "",
      instructionNames: [],
      parserConfirmed: false,
      parserMessage: "No confirmed parser for this program yet"
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(idlPath, "utf8")) as { instructions?: Array<{ name?: string }> };

    return {
      idlPath,
      instructionNames: parsed.instructions?.map((entry) => entry.name).filter((entry): entry is string => Boolean(entry)) ?? [],
      parserConfirmed: true,
      parserMessage: `Loaded IDL from ${idlPath}`
    };
  } catch (error) {
    logger.warn({ error, idlPath }, "Failed to load X1Factory IDL");
    return {
      idlPath,
      instructionNames: [],
      parserConfirmed: false,
      parserMessage: "No confirmed parser for this program yet"
    };
  }
}

function toDate(blockTime?: number | null): Date | null {
  return typeof blockTime === "number" ? new Date(blockTime * 1000) : null;
}

function rigTypeFromPurchaseEvent(hp: unknown, durationDays: unknown): RigType | null {
  if (hp === 100 && durationDays === 7) {
    return "starter";
  }

  if (hp === 800 && durationDays === 14) {
    return "pro";
  }

  if (hp === 1600 && durationDays === 28) {
    return "industrial";
  }

  return null;
}

function isPartiallyDecodedInstruction(
  instruction: ParsedInstruction | PartiallyDecodedInstruction
): instruction is PartiallyDecodedInstruction {
  return "data" in instruction;
}

function formatRawSummary(txHash: string, instructionNames: string[], eventNames: string[]): string {
  return [txHash, instructionNames.join(","), eventNames.join(",")].filter(Boolean).join(" | ");
}

function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toJsonSafe(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, toJsonSafe(entry)])
    );
  }

  return value;
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

export class RealX1FactoryAdapter implements IX1FactoryAdapter {
  private readonly connection = new Connection(env.x1RpcUrl ?? DEFAULT_RPC_URL, "confirmed");
  private readonly programId = new PublicKey(env.x1FactoryProgramId ?? DEFAULT_PROGRAM_ID);
  private readonly artifact = loadProgramArtifact();
  private readonly diagnostics = new Map<string, ScannerDiagnostics>();

  async getCurrentSlot(): Promise<number> {
    return this.connection.getSlot("confirmed");
  }

  getProgramId(): string {
    return this.programId.toBase58();
  }

  getRpcHost(): string {
    try {
      return new URL(env.x1RpcUrl ?? DEFAULT_RPC_URL).host;
    } catch {
      return env.x1RpcUrl ?? DEFAULT_RPC_URL;
    }
  }

  getIdlPath(): string | null {
    return this.artifact.idlPath || null;
  }

  getParserStatus(): { confirmed: boolean; message: string } {
    return {
      confirmed: this.artifact.parserConfirmed,
      message: this.artifact.parserMessage
    };
  }

  getWalletDiagnostics(wallet: string): ScannerDiagnostics {
    return (
      this.diagnostics.get(wallet) ?? {
        wallet,
        parserConfirmed: this.artifact.parserConfirmed,
        parserMessage: this.artifact.parserMessage,
        candidates: []
      }
    );
  }

  async inspectWallet(wallet: string, sinceSlot?: number): Promise<ScannerWalletResult> {
    const events = await this.getRecentUserEvents(wallet, sinceSlot);
    const state = await this.getUserFactoryState(wallet);
    const diagnostics = this.getWalletDiagnostics(wallet);

    return {
      wallet,
      parserConfirmed: diagnostics.parserConfirmed,
      parserMessage: diagnostics.parserMessage,
      state,
      events,
      diagnostics: diagnostics.candidates,
      currentSlot: state?.lastUpdatedSlot ?? null
    };
  }

  async getUserFactoryState(wallet: string): Promise<UserFactoryState | null> {
    if (!this.artifact.parserConfirmed) {
      await this.captureDiagnostics(wallet);
      return null;
    }

    const owner = new PublicKey(wallet);
    const currentSlot = await this.getCurrentSlot();
    const profileAddress = PublicKey.findProgramAddressSync([Buffer.from("profile"), owner.toBuffer()], this.programId)[0];
    const stakeAddress = PublicKey.findProgramAddressSync([Buffer.from("stake"), owner.toBuffer()], this.programId)[0];

    const [profileInfo, stakeInfo] = await Promise.all([
      this.connection.getAccountInfo(profileAddress, "confirmed"),
      this.connection.getAccountInfo(stakeAddress, "confirmed")
    ]);

    if (!profileInfo?.data || !isExpectedAccountDiscriminator(profileInfo.data, "UserMiningProfile")) {
      this.diagnostics.set(wallet, {
        wallet,
        parserConfirmed: true,
        parserMessage: this.artifact.parserMessage,
        candidates: []
      });
      return {
        wallet,
        activeRigs: 0,
        activeStarterCount: 0,
        activeProCount: 0,
        activeIndustrialCount: 0,
        totalActiveHp: 0,
        stakedMindAmount: 0,
        pendingClaimableMind: null,
        lastUpdatedSlot: currentSlot,
        positions: []
      };
    }

    const profile = decodeUserMiningProfileAccount(profileInfo.data);
    const totalPositions = profile.nextPositionIndex;
    const nowTs = Math.floor(Date.now() / 1000);
    const positionKeys = Array.from({ length: totalPositions }, (_, index) =>
      PublicKey.findProgramAddressSync([Buffer.from("position"), owner.toBuffer(), positionIndexSeed(index)], this.programId)[0]
    );

    const positionsInfo = positionKeys.length > 0 ? await this.connection.getMultipleAccountsInfo(positionKeys, "confirmed") : [];
    const positions = positionsInfo.flatMap((info, index) => {
      if (!info?.data || !isExpectedAccountDiscriminator(info.data, "MinerPosition")) {
        return [];
      }

      const position = decodeMinerPositionAccountSafe(info.data);
      const active = !position.deactivated && !position.expired && position.endTs > nowTs && position.rigType != null;

      if (!position.rigType) {
        return [];
      }

      return [
        {
          index,
          rigType: position.rigType,
          hp: position.hp,
          startTs: position.startTs,
          active,
          deactivated: position.deactivated,
          expired: position.expired,
          endTs: position.endTs
        }
      ];
    });

    const activePositions = positions.filter((position) => position.active);
    const activeStarterCount = activePositions.filter((position) => position.rigType === "starter").length;
    const activeProCount = activePositions.filter((position) => position.rigType === "pro").length;
    const activeIndustrialCount = activePositions.filter((position) => position.rigType === "industrial").length;
    const totalActiveHp = activePositions.reduce((total, position) => total + position.hp, 0);
    const stake = stakeInfo?.data && isExpectedAccountDiscriminator(stakeInfo.data, "UserStake")
      ? decodeUserStakeAccount(stakeInfo.data)
      : null;

    this.diagnostics.set(wallet, {
      wallet,
      parserConfirmed: true,
      parserMessage: this.artifact.parserMessage,
      candidates: []
    });

    return {
      wallet,
      activeRigs: activePositions.length,
      activeStarterCount,
      activeProCount,
      activeIndustrialCount,
      totalActiveHp,
      stakedMindAmount: stake?.stakedMind ?? 0,
      pendingClaimableMind: null,
      lastUpdatedSlot: currentSlot,
      positions
    };
  }

  async getRecentUserEvents(wallet: string, sinceSlot?: number): Promise<X1FactoryEvent[]> {
    const scan = await this.loadWalletEvents(wallet, sinceSlot);
    return scan.events;
  }

  private async captureDiagnostics(wallet: string): Promise<void> {
    const scan = await this.loadWalletEvents(wallet);
    this.diagnostics.set(wallet, {
      wallet,
      parserConfirmed: false,
      parserMessage: "No confirmed parser for this program yet",
      candidates: scan.candidates
    });
  }

  private async loadWalletEvents(
    wallet: string,
    sinceSlot?: number
  ): Promise<{ events: X1FactoryEvent[]; candidates: ScannerDiagnosticCandidate[] }> {
    const walletKey = new PublicKey(wallet);
    const signatures = await this.connection.getSignaturesForAddress(walletKey, { limit: 100 }, "confirmed");
    const filtered = signatures
      .filter((entry) => !entry.err && (sinceSlot == null || entry.slot > sinceSlot))
      .sort((left, right) => left.slot - right.slot);

    if (filtered.length === 0) {
      this.diagnostics.set(wallet, {
        wallet,
        parserConfirmed: this.artifact.parserConfirmed,
        parserMessage: this.artifact.parserMessage,
        candidates: []
      });
      return {
        events: [],
        candidates: []
      };
    }

    const parsedTransactions = await getParsedTransactionsInBatches(
      this.connection,
      filtered.map((entry) => entry.signature)
    );

    const candidates: ScannerDiagnosticCandidate[] = [];
    const events: X1FactoryEvent[] = [];
    const pendingRenewals: PendingRenewal[] = [];

    for (let index = 0; index < filtered.length; index += 1) {
      const signatureInfo = filtered[index];
      const parsed = parsedTransactions[index];

      if (!parsed) {
        continue;
      }

      const instructionMatches = this.extractProgramInstructions(parsed);
      const eventMatches = this.extractProgramEvents(parsed.meta?.logMessages ?? []);

      if (instructionMatches.length === 0 && eventMatches.length === 0) {
        continue;
      }

      const instructionNames = instructionMatches.map((entry) => entry.name);
      const eventNames = eventMatches.map((entry) => entry.name);

      candidates.push({
        txHash: signatureInfo.signature,
        slot: signatureInfo.slot,
        blockTime: toDate(signatureInfo.blockTime),
        instructionNames,
        eventNames,
        rawSummary: formatRawSummary(signatureInfo.signature, instructionNames, eventNames)
      });

      if (!this.artifact.parserConfirmed) {
        continue;
      }

      const decodedInstructionNames = new Set(instructionMatches.map((entry) => entry.name));
      const walletPurchaseEvents = eventMatches.filter(
        (entry) => entry.name === "ContractPurchased" && entry.fields.owner === wallet
      );
      const walletClaimEvents = eventMatches.filter(
        (entry) => entry.name === "MindClaimed" && entry.fields.owner === wallet
      );
      const walletStakeEvents = eventMatches.filter(
        (entry) => entry.name === "MindStaked" && entry.fields.owner === wallet
      );

      if (!decodedInstructionNames.has("claimMind") && walletClaimEvents.length > 0) {
        const totalAtomic = walletClaimEvents.reduce((total, entry) => {
          const amountAtomic = entry.fields.amountAtomic;
          return total + (typeof amountAtomic === "bigint" ? amountAtomic : 0n);
        }, 0n);

        events.push({
          wallet,
          eventType: "claim_mind_daily",
          txHash: signatureInfo.signature,
          slot: signatureInfo.slot,
          blockTime: toDate(signatureInfo.blockTime),
          amount: mindAtomicToDecimal(totalAtomic),
          rigType: null,
          raw: {
            instruction: "claimMind",
            events: walletClaimEvents.map((entry) => ({ name: entry.name, fields: toJsonSafe(entry.fields) })),
            amountAtomic: totalAtomic.toString(),
            source: "log_fallback"
          }
        });
      }

      if (!decodedInstructionNames.has("stakeMind") && walletStakeEvents.length > 0) {
        const totalAtomic = walletStakeEvents.reduce((total, entry) => {
          const amountAtomic = entry.fields.amountAtomic;
          return total + (typeof amountAtomic === "bigint" ? amountAtomic : 0n);
        }, 0n);

        events.push({
          wallet,
          eventType: "stake_snapshot",
          txHash: signatureInfo.signature,
          slot: signatureInfo.slot,
          blockTime: toDate(signatureInfo.blockTime),
          amount: mindAtomicToDecimal(totalAtomic),
          rigType: null,
          raw: {
            instruction: "stakeMind",
            events: walletStakeEvents.map((entry) => ({ name: entry.name, fields: toJsonSafe(entry.fields) })),
            amountAtomic: totalAtomic.toString(),
            source: "log_fallback"
          }
        });
      }

      if (!decodedInstructionNames.has("buyContract") && walletPurchaseEvents.length > 0) {
        for (const [purchaseEventIndex, purchaseEvent] of walletPurchaseEvents.entries()) {
          const rigType = rigTypeFromPurchaseEvent(purchaseEvent.fields.hp, purchaseEvent.fields.durationDays);
          const eventType = this.purchaseEventTypeFromRigType(rigType);

          if (!rigType || !eventType) {
            continue;
          }

          events.push({
            wallet,
            eventType,
            txHash: signatureInfo.signature,
            slot: signatureInfo.slot,
            blockTime: toDate(signatureInfo.blockTime),
            amount: null,
            rigType,
            raw: {
              instruction: "buyContract",
              events: [{ name: purchaseEvent.name, fields: toJsonSafe(purchaseEvent.fields) }],
              source: "log_fallback",
              eventIndex: purchaseEventIndex
            }
          });
        }
      }

      for (const instruction of instructionMatches) {
        const blockTime = toDate(signatureInfo.blockTime);
        const rawBase = {
          instruction: instruction.name,
          accounts: instruction.accounts,
          events: eventMatches.map((entry) => ({ name: entry.name, fields: toJsonSafe(entry.fields) }))
        };

        if (instruction.name === "buyContract") {
          const args = decodeBuyContractArgs(instruction.data);
          const rigType = rigTypeFromIndex(args.contractType);
          const eventType = this.purchaseEventTypeFromRigType(rigType);

          if (!eventType || !rigType) {
            continue;
          }

          events.push({
            wallet,
            eventType,
            txHash: signatureInfo.signature,
            slot: signatureInfo.slot,
            blockTime,
            amount: null,
            rigType,
            raw: {
              ...rawBase,
              contractType: args.contractType,
              positionIndex: args.positionIndex
            }
          });
        }

        if (instruction.name === "renewRig" || instruction.name === "renewRigWithBuff") {
          const positionAddress = instruction.accounts.find((account) => account.role === "position")?.pubkey;

          if (!positionAddress) {
            continue;
          }

          pendingRenewals.push({
            txHash: signatureInfo.signature,
            slot: signatureInfo.slot,
            blockTime,
            positionAddress,
            raw: rawBase
          });
        }

        if (instruction.name === "claimMind") {
          const amountAtomic = walletClaimEvents.reduce((total, entry) => {
            const value = entry.fields.amountAtomic;
            return total + (typeof value === "bigint" ? value : 0n);
          }, 0n);

          if (amountAtomic === 0n) {
            continue;
          }

          events.push({
            wallet,
            eventType: "claim_mind_daily",
            txHash: signatureInfo.signature,
            slot: signatureInfo.slot,
            blockTime,
            amount: mindAtomicToDecimal(amountAtomic),
            rigType: null,
            raw: {
              ...rawBase,
              amountAtomic: amountAtomic.toString()
            }
          });
        }

        if (instruction.name === "stakeMind") {
          const totalStakeAtomic = walletStakeEvents.reduce((total, entry) => {
            const value = entry.fields.amountAtomic;
            return total + (typeof value === "bigint" ? value : 0n);
          }, 0n);
          const args = decodeStakeMindArgs(instruction.data);
          const amountAtomic = totalStakeAtomic > 0n ? totalStakeAtomic : args.amountAtomic;

          events.push({
            wallet,
            eventType: "stake_snapshot",
            txHash: signatureInfo.signature,
            slot: signatureInfo.slot,
            blockTime,
            amount: mindAtomicToDecimal(amountAtomic),
            rigType: null,
            raw: {
              ...rawBase,
              amountAtomic: amountAtomic.toString()
            }
          });
        }
      }
    }

    if (pendingRenewals.length > 0) {
      const renewalAccounts = await this.connection.getMultipleAccountsInfo(
        pendingRenewals.map((entry) => new PublicKey(entry.positionAddress)),
        "confirmed"
      );

      for (let index = 0; index < pendingRenewals.length; index += 1) {
        const pending = pendingRenewals[index];
        const account = renewalAccounts[index];

        if (!account?.data || !isExpectedAccountDiscriminator(account.data, "MinerPosition")) {
          continue;
        }

        const decoded = decodeMinerPositionAccountSafe(account.data);
        const eventType = this.renewalEventTypeFromRigType(decoded.rigType);

        if (!eventType || !decoded.rigType) {
          continue;
        }

        events.push({
          wallet,
          eventType,
          txHash: pending.txHash,
          slot: pending.slot,
          blockTime: pending.blockTime,
          amount: null,
          rigType: decoded.rigType,
          raw: {
            ...pending.raw,
            positionAddress: pending.positionAddress
          }
        });
      }
    }

    this.diagnostics.set(wallet, {
      wallet,
      parserConfirmed: this.artifact.parserConfirmed,
      parserMessage: this.artifact.parserMessage,
      candidates: candidates.slice(-10)
    });

    return {
      events: events.sort((left, right) => left.slot - right.slot),
      candidates
    };
  }

  private extractProgramInstructions(parsed: ParsedTransactionWithMeta) {
    const instructions = parsed.transaction.message.instructions;

    return instructions.flatMap((instruction) => {
      if (!isPartiallyDecodedInstruction(instruction)) {
        return [];
      }

      if (!instruction.programId.equals(this.programId)) {
        return [];
      }

      const name = decodeInstructionName(instruction.data, [...this.artifact.instructionNames, ...SUPPORTED_INSTRUCTIONS]);

      if (!name) {
        return [];
      }

      const accountRoles = this.getInstructionAccountRoles(name);

      return [
        {
          name,
          data: instruction.data,
          accounts: instruction.accounts.map((account, index) => ({
            pubkey: account.toBase58(),
            role: accountRoles[index] ?? `account_${index}`
          }))
        }
      ];
    });
  }

  private extractProgramEvents(logMessages: string[]) {
    return logMessages.flatMap((line) => {
      const match = line.match(/^Program data: (.+)$/);

      if (!match) {
        return [];
      }

      try {
        const decoded = decodeAnchorEvent(Buffer.from(match[1], "base64"));
        return decoded ? [decoded] : [];
      } catch {
        return [];
      }
    });
  }

  private getInstructionAccountRoles(name: string): string[] {
    if (name === "buyContract") {
      return ["owner", "config", "userProfile", "position"];
    }

    if (name === "renewRig") {
      return ["owner", "config", "userProfile", "position"];
    }

    if (name === "renewRigWithBuff") {
      return ["owner", "config", "rigBuffConfig", "userProfile", "position"];
    }

    if (name === "claimMind") {
      return ["owner", "config", "userProfile", "position"];
    }

    if (name === "stakeMind") {
      return ["owner", "config", "userProfile", "userStake"];
    }

    return [];
  }

  private purchaseEventTypeFromRigType(rigType: RigType | null): ScannerEventType | null {
    if (rigType === "starter") {
      return "starter_rig_purchase";
    }

    if (rigType === "pro") {
      return "pro_rig_purchase";
    }

    if (rigType === "industrial") {
      return "industrial_rig_purchase";
    }

    return null;
  }

  private renewalEventTypeFromRigType(rigType: RigType | null): ScannerEventType | null {
    if (rigType === "starter") {
      return "starter_renewal";
    }

    if (rigType === "pro") {
      return "pro_renewal";
    }

    if (rigType === "industrial") {
      return "industrial_renewal";
    }

    return null;
  }
}
