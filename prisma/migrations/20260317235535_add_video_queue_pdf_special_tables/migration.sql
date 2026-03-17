-- CreateEnum
CREATE TYPE "DeliveryJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "minVideoCount" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "pricePerVideo" DOUBLE PRECISION NOT NULL DEFAULT 5;

-- CreateTable
CREATE TABLE "password_reset_otps" (
    "id" TEXT NOT NULL,
    "telegramUsername" TEXT NOT NULL,
    "otp" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_delivery_jobs" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userTelegramId" BIGINT NOT NULL,
    "category" "Category" NOT NULL,
    "videoCount" INTEGER NOT NULL,
    "status" "DeliveryJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_delivery_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pdf_categories" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pdf_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pdf_subcategories" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "categoryId" TEXT NOT NULL,

    CONSTRAINT "pdf_subcategories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pdf_series" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "bannerUrl" TEXT,
    "subcategoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pdf_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "free_pdfs" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileSize" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "seriesId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "free_pdfs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pdf_categories_slug_key" ON "pdf_categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "pdf_subcategories_slug_key" ON "pdf_subcategories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "pdf_series_slug_key" ON "pdf_series"("slug");

-- AddForeignKey
ALTER TABLE "video_delivery_jobs" ADD CONSTRAINT "video_delivery_jobs_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_delivery_jobs" ADD CONSTRAINT "video_delivery_jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pdf_subcategories" ADD CONSTRAINT "pdf_subcategories_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "pdf_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pdf_series" ADD CONSTRAINT "pdf_series_subcategoryId_fkey" FOREIGN KEY ("subcategoryId") REFERENCES "pdf_subcategories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "free_pdfs" ADD CONSTRAINT "free_pdfs_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "pdf_series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
