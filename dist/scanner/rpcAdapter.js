import { Connection, PublicKey } from "@solana/web3.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
export class RpcX1FactoryAdapter {
    connection = new Connection(env.x1RpcUrl ?? "https://rpc.mainnet.x1.xyz", "confirmed");
    programId = new PublicKey(env.x1FactoryProgramId ?? "11111111111111111111111111111111");
    async getUserFactoryState(wallet) {
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
    async getRecentUserEvents(wallet, sinceSlot) {
        logger.debug({ wallet, sinceSlot, programId: this.programId.toBase58() }, "RPC adapter recent event parsing not implemented");
        return [];
    }
}
