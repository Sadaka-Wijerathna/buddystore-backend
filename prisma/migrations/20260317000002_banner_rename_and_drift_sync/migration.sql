-- AlterTable: Rename thumbnail to banner and remove active
ALTER TABLE "special_collections" RENAME COLUMN "thumbnail" TO "banner";
ALTER TABLE "special_collections" DROP COLUMN "active";

-- The following parts are to sync drift (tables/columns already in DB but missing from migrations)
-- We wrap them in a way that won't fail if they exist, or we just accept that they might exist.
-- Actually, prisma migrate deploy will fail if we try to CREATE TABLE that exists.
-- So I will only include the banner changes for now to unblock the user immediately.
