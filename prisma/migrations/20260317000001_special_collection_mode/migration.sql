-- AlterTable: add collectionMode and totalVideos to special_collections
ALTER TABLE "special_collections" ADD COLUMN "collectionMode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "special_collections" ADD COLUMN "totalVideos" INTEGER NOT NULL DEFAULT 0;
