import type { DetectedEvent, Prisma, SeasonPoint } from "@prisma/client";

import { prisma } from "./prisma.js";

export async function createDetectedEvent(data: Prisma.DetectedEventUncheckedCreateInput): Promise<DetectedEvent> {
  return prisma.detectedEvent.create({
    data
  });
}

export async function findDetectedEvent(params: {
  txHash: string;
  eventType: string;
  walletId: number;
}): Promise<DetectedEvent | null> {
  return prisma.detectedEvent.findUnique({
    where: {
      txHash_eventType_walletId: params
    }
  });
}

export async function createSeasonPoint(data: Prisma.SeasonPointUncheckedCreateInput): Promise<SeasonPoint> {
  return prisma.seasonPoint.create({
    data
  });
}

export async function findSeasonPointByDetectedEventId(detectedEventId: number): Promise<SeasonPoint | null> {
  return prisma.seasonPoint.findFirst({
    where: {
      detectedEventId
    }
  });
}

export async function recordDetectedEventWithPoints(params: {
  event: Prisma.DetectedEventUncheckedCreateInput;
  points: Omit<Prisma.SeasonPointUncheckedCreateInput, "detectedEventId">;
}): Promise<{ detectedEvent: DetectedEvent; seasonPoint: SeasonPoint | null; created: boolean }> {
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
