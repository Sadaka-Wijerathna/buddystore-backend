-- CreateTable
CREATE TABLE "special_collections" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "thumbnail" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "special_collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "special_videos" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "special_videos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "special_collections_slug_key" ON "special_collections"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "special_videos_fileId_key" ON "special_videos"("fileId");

-- AddForeignKey
ALTER TABLE "special_videos" ADD CONSTRAINT "special_videos_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "special_collections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
