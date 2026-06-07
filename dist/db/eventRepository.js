import { prisma } from "./prisma.js";
export async function createDetectedEvent(data) {
    return prisma.detectedEvent.create({
        data
    });
}
export async function findDetectedEvent(params) {
    return prisma.detectedEvent.findUnique({
        where: {
            txHash_eventType_walletId: params
        }
    });
}
export async function createSeasonPoint(data) {
    return prisma.seasonPoint.create({
        data
    });
}
export async function findSeasonPointByDetectedEventId(detectedEventId) {
    return prisma.seasonPoint.findFirst({
        where: {
            detectedEventId
        }
    });
}
export async function recordDetectedEventWithPoints(params) {
    return prisma.$transaction(async (tx) => {
        const existing = await tx.detectedEvent.findUnique({
            where: {
                txHash_eventType_walletId: {
                    txHash: params.event.txHash,
                    eventType: params.event.eventType,
                    walletId: params.event.walletId
                }
            }
        });
        if (existing) {
            return {
                detectedEvent: existing,
                seasonPoint: null,
                created: false
            };
        }
        const detectedEvent = await tx.detectedEvent.create({
            data: params.event
        });
        const seasonPoint = await tx.seasonPoint.create({
            data: {
                ...params.points,
                detectedEventId: detectedEvent.id
            }
        });
        return {
            detectedEvent,
            seasonPoint,
            created: true
        };
    });
}
