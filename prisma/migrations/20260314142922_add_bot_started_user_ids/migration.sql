-- AlterTable
ALTER TABLE "bots" ADD COLUMN     "startedUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
