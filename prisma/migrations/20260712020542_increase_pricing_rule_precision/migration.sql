/*
  Warnings:

  - You are about to alter the column `costoA` on the `pricing_rules` table. The data in that column could be lost. The data in that column will be cast from `Decimal(18,8)` to `Decimal(24,20)`.
  - You are about to alter the column `costoB` on the `pricing_rules` table. The data in that column could be lost. The data in that column will be cast from `Decimal(18,8)` to `Decimal(24,20)`.
  - You are about to alter the column `costoC` on the `pricing_rules` table. The data in that column could be lost. The data in that column will be cast from `Decimal(18,8)` to `Decimal(24,20)`.

*/
-- AlterTable
ALTER TABLE `pricing_rules` MODIFY `costoA` DECIMAL(24, 20) NOT NULL,
    MODIFY `costoB` DECIMAL(24, 20) NOT NULL,
    MODIFY `costoC` DECIMAL(24, 20) NOT NULL;
