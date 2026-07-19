-- AlterTable: add mediaType to special_videos
ALTER TABLE "special_videos" ADD COLUMN IF NOT EXISTS "mediaType" TEXT NOT NULL DEFAULT 'video';

-- CreateIndex: index on collectionId + mediaType for efficient image/video count queries
CREATE INDEX IF NOT EXISTS "special_videos_collectionId_mediaType_idx" ON "special_videos"("collectionId", "mediaType");
