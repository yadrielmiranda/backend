/*
  Warnings:

  - You are about to alter the column `rateT` on the `estimate` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,4)` to `Decimal(12,2)`.
  - You are about to alter the column `netProfit` on the `estimate` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,4)` to `Decimal(12,2)`.
  - You are about to alter the column `rate` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,4)` to `Decimal(12,2)`.
  - You are about to alter the column `netProfit` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Decimal(12,4)` to `Decimal(12,2)`.

*/
-- AlterTable
ALTER TABLE `estimate` MODIFY `rateT` DECIMAL(12, 2) NOT NULL,
    MODIFY `netProfit` DECIMAL(12, 2) NOT NULL;

-- AlterTable
ALTER TABLE `piece` MODIFY `rate` DECIMAL(12, 2) NOT NULL,
    MODIFY `netProfit` DECIMAL(12, 2) NOT NULL,
    ALTER COLUMN `customerPrice` DROP DEFAULT,
    ALTER COLUMN `customerSubtotal` DROP DEFAULT;
