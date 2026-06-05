-- AlterTable
ALTER TABLE "SeasonPoint"
ADD COLUMN "category" TEXT NOT NULL DEFAULT 'manual';

-- CreateIndex
CREATE INDEX "SeasonPoint_seasonId_category_idx" ON "SeasonPoint"("seasonId", "category");
