/*
  Warnings:

  - You are about to drop the column `markupD` on the `piece` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `piece` DROP COLUMN `markupD`,
    ADD COLUMN `dealerMarkup` DECIMAL(10, 4) NOT NULL DEFAULT 0;
