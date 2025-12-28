/*
  Warnings:

  - You are about to alter the column `widthIn` on the `dimensionrule` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(10,3)`.
  - You are about to alter the column `heightIn` on the `dimensionrule` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(10,3)`.
  - You are about to alter the column `dpPosPsf` on the `dimensionrule` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(10,2)`.
  - You are about to alter the column `dpNegPsf` on the `dimensionrule` table. The data in that column could be lost. The data in that column will be cast from `Decimal(65,30)` to `Decimal(10,2)`.
  - You are about to alter the column `width` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,4)` to `Decimal(10,3)`.
  - You are about to alter the column `height` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,4)` to `Decimal(10,3)`.
  - You are about to alter the column `heightLeft` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,4)` to `Decimal(10,3)`.
  - You are about to alter the column `heightRight` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,4)` to `Decimal(10,3)`.
  - You are about to alter the column `legHeight` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `Decimal(10,4)` to `Decimal(10,3)`.

*/
-- AlterTable
ALTER TABLE `dimensionrule` MODIFY `widthIn` DECIMAL(10, 3) NOT NULL,
    MODIFY `heightIn` DECIMAL(10, 3) NOT NULL,
    MODIFY `dpPosPsf` DECIMAL(10, 2) NOT NULL,
    MODIFY `dpNegPsf` DECIMAL(10, 2) NOT NULL;

-- AlterTable
ALTER TABLE `estimate` ADD COLUMN `customerCity` VARCHAR(100) NULL,
    ADD COLUMN `customerEmail` VARCHAR(150) NULL,
    ADD COLUMN `customerFirstName` VARCHAR(100) NULL,
    ADD COLUMN `customerLastName` VARCHAR(100) NULL,
    ADD COLUMN `customerPhone` VARCHAR(30) NULL,
    ADD COLUMN `customerPostalCode` VARCHAR(20) NULL,
    ADD COLUMN `customerState` VARCHAR(50) NULL,
    ADD COLUMN `customerStreet` VARCHAR(150) NULL;

-- AlterTable
ALTER TABLE `piece` MODIFY `width` DECIMAL(10, 3) NULL,
    MODIFY `height` DECIMAL(10, 3) NULL,
    MODIFY `heightLeft` DECIMAL(10, 3) NULL,
    MODIFY `heightRight` DECIMAL(10, 3) NULL,
    MODIFY `legHeight` DECIMAL(10, 3) NULL;
