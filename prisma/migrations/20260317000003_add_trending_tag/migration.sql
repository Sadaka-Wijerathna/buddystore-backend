-- AlterTable: add trendingTag to special_collections
ALTER TABLE "special_collections" ADD COLUMN "trendingTag" TEXT NOT NULL DEFAULT 'Trending';
