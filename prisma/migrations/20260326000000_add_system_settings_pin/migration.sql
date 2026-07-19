-- CreateTable
CREATE TABLE "system_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "previewPin" TEXT,
    "previewPinExpiresAt" TIMESTAMP(3),

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "bots" ADD COLUMN IF NOT EXISTS "bannerUrl" TEXT;
