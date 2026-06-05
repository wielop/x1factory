import { Keypair } from "@solana/web3.js";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const profiles = await prisma.clickerProfile.findMany({
    include: {
      user: true,
      season: true,
      clickerWallet: true
    },
    orderBy: [
      {
        seasonId: "asc"
      },
      {
        userId: "asc"
      }
    ]
  });

  let migrated = 0;

  for (const profile of profiles) {
    const newWallet = await prisma.wallet.create({
      data: {
        address: Keypair.generate().publicKey.toBase58(),
        label: `Clicker Wallet // ${profile.season.name}`,
        userId: profile.userId,
        isActive: false
      }
    });

    await prisma.$transaction([
      prisma.clickerProfile.update({
        where: {
          userId_seasonId: {
            userId: profile.userId,
            seasonId: profile.seasonId
          }
        },
        data: {
          clickerWalletId: newWallet.id
        }
      }),
      prisma.clickerSession.updateMany({
        where: {
          userId: profile.userId,
          seasonId: profile.seasonId
        },
        data: {
          clickerWalletId: newWallet.id
        }
      }),
      prisma.clickerClaim.updateMany({
        where: {
          userId: profile.userId,
          seasonId: profile.seasonId
        },
        data: {
          clickerWalletId: newWallet.id
        }
      })
    ]);

    migrated += 1;
    console.log(
      [
        `Migrated user ${profile.user.username ? `@${profile.user.username}` : profile.user.telegramId.toString()}`,
        `season ${profile.season.name}`,
        `old clicker wallet ${profile.clickerWallet?.address ?? "none"}`,
        `new clicker wallet ${newWallet.address}`
      ].join(" | ")
    );
  }

  console.log(`Done. Migrated ${migrated} clicker profile(s).`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
