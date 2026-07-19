-- Migration: add_missing_columns
-- Adds columns that exist in schema.prisma but were not applied via migration.
-- Uses IF NOT EXISTS to be safe against partial states.

-- Add telegram_unique_id to videos (required for duplicate prevention)
ALTER TABLE "videos" ADD COLUMN IF NOT EXISTS "telegramUniqueId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "videos_telegramUniqueId_key" ON "videos"("telegramUniqueId");

-- Add thumbnail_url to videos (may already exist in DB due to direct SQL — safe to re-add with IF NOT EXISTS)
ALTER TABLE "videos" ADD COLUMN IF NOT EXISTS "thumbnailUrl" TEXT;

-- Add thumbnail_url to special_videos (same situation)
ALTER TABLE "special_videos" ADD COLUMN IF NOT EXISTS "thumbnailUrl" TEXT;

-- Add order to special_collections (same situation)
ALTER TABLE "special_collections" ADD COLUMN IF NOT EXISTS "order" INTEGER NOT NULL DEFAULT 0;
