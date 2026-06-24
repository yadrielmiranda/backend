-- AlterTable
ALTER TABLE `Brand` ADD COLUMN `highBottomPercent` DECIMAL(10, 4) NULL;

-- AlterTable
ALTER TABLE `Piece` ADD COLUMN `highBottom` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `highBottomPercent` DECIMAL(10, 4) NULL;

-- AlterTable
ALTER TABLE `System` ADD COLUMN `allowHighBottom` BOOLEAN NOT NULL DEFAULT false;
