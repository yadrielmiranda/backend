/*
  Warnings:

  - You are about to alter the column `markup` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,4)` to `Decimal(24,18)`.
  - You are about to alter the column `markup` on the `role` table. The data in that column could be lost. The data in that column will be cast from `Decimal(24,18)` to `Decimal(10,4)`.

*/
-- AlterTable
ALTER TABLE `Piece` MODIFY `markup` DECIMAL(24, 18) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `Role` MODIFY `markup` DECIMAL(10, 4) NOT NULL DEFAULT 0;
