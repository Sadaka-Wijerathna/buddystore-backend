-- CreateIndex
CREATE INDEX "free_pdfs_seriesId_order_idx" ON "free_pdfs"("seriesId", "order");

-- CreateIndex
CREATE INDEX "special_videos_collectionId_collectedAt_idx" ON "special_videos"("collectionId", "collectedAt");

-- CreateIndex
CREATE INDEX "videos_category_collectedAt_idx" ON "videos"("category", "collectedAt");
