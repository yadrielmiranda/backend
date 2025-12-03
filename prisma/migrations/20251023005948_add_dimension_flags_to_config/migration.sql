/*
  Warnings:

  - You are about to alter the column `width` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `Decimal(10,4)`.
  - You are about to alter the column `height` on the `piece` table. The data in that column could be lost. The data in that column will be cast from `VarChar(191)` to `Decimal(10,4)`.

*/
-- AlterTable
ALTER TABLE `config` ADD COLUMN `requiresHeight` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresHeightLeft` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresHeightRight` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresLegHeight` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `requiresWidth` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `piece` ADD COLUMN `heightLeft` DECIMAL(10, 4) NULL,
    ADD COLUMN `heightRight` DECIMAL(10, 4) NULL,
    ADD COLUMN `legHeight` DECIMAL(10, 4) NULL,
    MODIFY `width` DECIMAL(10, 4) NULL,
    MODIFY `height` DECIMAL(10, 4) NULL;
