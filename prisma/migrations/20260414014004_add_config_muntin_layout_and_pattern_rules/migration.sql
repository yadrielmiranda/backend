-- AlterTable
ALTER TABLE `config` ADD COLUMN `muntinLayout` JSON NULL;

-- AlterTable
ALTER TABLE `muntin_patterns` ADD COLUMN `requiresLites` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `piece_muntin_panels` ADD COLUMN `panelLabel` VARCHAR(100) NULL,
    MODIFY `panelCode` VARCHAR(20) NOT NULL;
