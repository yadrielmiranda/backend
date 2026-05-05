/*
  Warnings:

  - You are about to drop the column `isGlobalDefault` on the `framecolor` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE FrameColor DROP COLUMN isGlobalDefault;
ALTER TABLE FrameColor ADD COLUMN isGlobal BOOLEAN DEFAULT false;
