/*
  Warnings:

  - You are about to alter the column `rateT` on the `estimate` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(12,4)`.
  - You are about to alter the column `priceT` on the `estimate` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(12,2)`.
  - You are about to alter the column `netProfit` on the `estimate` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(12,4)`.
  - You are about to alter the column `total` on the `estimate` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(12,2)`.
  - You are about to alter the column `netProfitD` on the `estimate` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(12,2)`.
  - You are about to alter the column `amount` on the `order` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(12,2)`.
  - You are about to alter the column `rate` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(12,4)`.
  - You are about to alter the column `price` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(12,2)`.
  - You are about to alter the column `subtotal` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(12,2)`.
  - You are about to alter the column `netProfit` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(12,4)`.
  - You are about to alter the column `markupD` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(12,2)`.
  - You are about to alter the column `netProfitD` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(12,2)`.
  - You are about to alter the column `costoA` on the `pricing_rules` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(18,8)`.
  - You are about to alter the column `costoB` on the `pricing_rules` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(18,8)`.
  - You are about to alter the column `costoC` on the `pricing_rules` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(18,8)`.
  - You are about to alter the column `markup` on the `role` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(10,4)`.
  - You are about to alter the column `markupOverride` on the `user` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(10,4)`.

*/
-- AlterTable
ALTER TABLE `estimate` MODIFY `rateT` DECIMAL(12, 4) NOT NULL,
    MODIFY `priceT` DECIMAL(12, 2) NOT NULL,
    MODIFY `netProfit` DECIMAL(12, 4) NOT NULL,
    MODIFY `total` DECIMAL(12, 2) NOT NULL,
    MODIFY `netProfitD` DECIMAL(12, 2) NOT NULL;

-- AlterTable
ALTER TABLE `order` MODIFY `amount` DECIMAL(12, 2) NOT NULL;

-- AlterTable
ALTER TABLE `piece` MODIFY `rate` DECIMAL(12, 4) NOT NULL,
    MODIFY `price` DECIMAL(12, 2) NOT NULL,
    MODIFY `subtotal` DECIMAL(12, 2) NOT NULL,
    MODIFY `netProfit` DECIMAL(12, 4) NOT NULL,
    MODIFY `markupD` DECIMAL(12, 2) NOT NULL,
    MODIFY `netProfitD` DECIMAL(12, 2) NOT NULL;

-- AlterTable
ALTER TABLE `pricing_rules` MODIFY `costoA` DECIMAL(18, 8) NOT NULL,
    MODIFY `costoB` DECIMAL(18, 8) NOT NULL,
    MODIFY `costoC` DECIMAL(18, 8) NOT NULL;

-- AlterTable
ALTER TABLE `role` MODIFY `markup` DECIMAL(10, 4) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `user` MODIFY `markupOverride` DECIMAL(10, 4) NULL;
