-- CreateEnum
CREATE TYPE "Role" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "Category" AS ENUM ('MIXED', 'MOM_SON', 'SRI_LANKAN', 'CCTV', 'PUBLIC', 'RAPE');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DELIVERING', 'COMPLETED', 'REJECTED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "telegramUsername" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "languageCode" TEXT,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'USER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "telegramUsername" TEXT NOT NULL,
    "telegramId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "languageCode" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bots" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "collectionMode" BOOLEAN NOT NULL DEFAULT false,
    "totalVideos" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "videos" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "botId" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "category" "Category" NOT NULL,
    "videoCount" INTEGER NOT NULL,
    "receiptUrl" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
    "confirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_deliveries" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "video_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegramId_key" ON "users"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "users_telegramUsername_key" ON "users"("telegramUsername");

-- CreateIndex
CREATE UNIQUE INDEX "registration_tokens_token_key" ON "registration_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "bots_name_key" ON "bots"("name");

-- CreateIndex
CREATE UNIQUE INDEX "bots_category_key" ON "bots"("category");

-- CreateIndex
CREATE UNIQUE INDEX "videos_fileId_key" ON "videos"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "video_deliveries_videoId_userId_key" ON "video_deliveries"("videoId", "userId");

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_deliveries" ADD CONSTRAINT "video_deliveries_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_deliveries" ADD CONSTRAINT "video_deliveries_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_deliveries" ADD CONSTRAINT "video_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
