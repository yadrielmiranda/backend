/*
  Warnings:

  - You are about to alter the column `markup` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Int` to `Decimal(10,4)`.

*/
-- AlterTable
ALTER TABLE `piece` MODIFY `markup` DECIMAL(10, 4) NOT NULL DEFAULT 0;
