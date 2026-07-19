-- AlterTable: add isTrending to special_collections
ALTER TABLE "special_collections" ADD COLUMN "isTrending" BOOLEAN NOT NULL DEFAULT false;
