-- CreateTable
CREATE TABLE "WalletScannerCursor" (
    "id" SERIAL NOT NULL,
    "walletId" INTEGER NOT NULL,
    "lastSlot" BIGINT,
    "snapshot" JSONB,
    "scannedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletScannerCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletScannerCursor_walletId_key" ON "WalletScannerCursor"("walletId");

-- AddForeignKey
ALTER TABLE "WalletScannerCursor" ADD CONSTRAINT "WalletScannerCursor_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
