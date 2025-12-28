/*
  Warnings:

  - You are about to drop the column `total` on the `estimate` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `estimate` DROP COLUMN `total`,
    ADD COLUMN `customerPriceT` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `customerTaxAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `customerTaxRate` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    ADD COLUMN `customerTotalPayable` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    MODIFY `netProfitD` DECIMAL(12, 2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `piece` ADD COLUMN `customerPrice` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `customerSubtotal` DECIMAL(12, 2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `user` ADD COLUMN `isTaxExempt` BOOLEAN NOT NULL DEFAULT false;
