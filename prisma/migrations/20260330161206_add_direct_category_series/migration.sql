-- AlterTable
ALTER TABLE "pdf_series" ADD COLUMN     "categoryId" TEXT,
ALTER COLUMN "subcategoryId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "pdf_series" ADD CONSTRAINT "pdf_series_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "pdf_categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;
