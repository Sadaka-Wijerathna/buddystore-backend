-- Fix: Add missing telegramUniqueId column to special_videos
-- This column exists in schema.prisma but was never added to the live DB,
-- causing PrismaClientKnownRequestError P2022 "column not available" on SpecialBot startup.

ALTER TABLE "special_videos" ADD COLUMN IF NOT EXISTS "telegramUniqueId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "special_videos_telegramUniqueId_key" ON "special_videos"("telegramUniqueId");
