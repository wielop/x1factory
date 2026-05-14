import { Connection, PublicKey } from "@solana/web3.js";

import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

import type { IX1FactoryAdapter, X1FactoryRecentEvent, X1FactoryState } from "./types.js";

export class RpcX1FactoryAdapter implements IX1FactoryAdapter {
  private readonly connection = new Connection(env.x1RpcUrl ?? "https://rpc.mainnet.x1.xyz", "confirmed");
  private readonly programId = new PublicKey(
    env.x1FactoryProgramId ?? "11111111111111111111111111111111"
  );

  async getUserFactoryState(wallet: string): Promise<X1FactoryState | null> {
    logger.debug({ wallet, programId: this.programId.toBase58() }, "RPC adapter state parsing not implemented");

    const slot = await this.connection.getSlot("confirmed");

    return {
      slot,
      starterRigs: 0,
      proRigs: 0,
      industrialRigs: 0,
      renewalsCount: 0,
      totalMindClaimed: 0,
      hasStake: false,
      totalMindBurned: 0,
      activeRigToday: false,
      activeRigDayKey: null
    };
  }

  async getRecentUserEvents(wallet: string, sinceSlot?: number): Promise<X1FactoryRecentEvent[]> {
    logger.debug(
      { wallet, sinceSlot, programId: this.programId.toBase58() },
      "RPC adapter recent event parsing not implemented"
    );

    return [];
  }
}
