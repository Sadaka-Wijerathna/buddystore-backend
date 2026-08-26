-- CreateIndex
CREATE INDEX "bot_verify_tokens_userId_category_verified_idx" ON "bot_verify_tokens"("userId", "category", "verified");

-- CreateIndex
CREATE INDEX "orders_userId_idx" ON "orders"("userId");

-- CreateIndex
CREATE INDEX "orders_status_createdAt_idx" ON "orders"("status", "createdAt");

-- CreateIndex
CREATE INDEX "orders_receiptUrl_idx" ON "orders"("receiptUrl");

-- CreateIndex
CREATE INDEX "video_deliveries_userId_idx" ON "video_deliveries"("userId");

-- CreateIndex
CREATE INDEX "video_deliveries_orderId_idx" ON "video_deliveries"("orderId");

-- CreateIndex
CREATE INDEX "video_delivery_jobs_status_createdAt_idx" ON "video_delivery_jobs"("status", "createdAt");

-- CreateIndex
CREATE INDEX "video_delivery_jobs_orderId_idx" ON "video_delivery_jobs"("orderId");

-- CreateIndex
CREATE INDEX "videos_category_thumbnailUrl_idx" ON "videos"("category", "thumbnailUrl");

-- CreateIndex
CREATE INDEX "videos_botId_idx" ON "videos"("botId");
