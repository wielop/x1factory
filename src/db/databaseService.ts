import { prisma } from "./prisma.js";

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

export async function isDatabaseHealthy(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
