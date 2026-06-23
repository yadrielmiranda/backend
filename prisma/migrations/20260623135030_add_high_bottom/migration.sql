-- AlterTable
ALTER TABLE `brand` ADD COLUMN `highBottomPercent` DECIMAL(10, 4) NULL;

-- AlterTable
ALTER TABLE `piece` ADD COLUMN `highBottom` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `highBottomPercent` DECIMAL(10, 4) NULL;

-- AlterTable
ALTER TABLE `system` ADD COLUMN `allowHighBottom` BOOLEAN NOT NULL DEFAULT false;
