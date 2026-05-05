/*
  Warnings:

  - You are about to drop the column `defaultFrameColorId` on the `system` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE `system` DROP FOREIGN KEY `System_defaultFrameColorId_fkey`;

-- DropIndex
DROP INDEX `System_defaultFrameColorId_idx` ON `system`;

-- AlterTable
ALTER TABLE `system` DROP COLUMN `defaultFrameColorId`;
