-- AlterTable
ALTER TABLE `linear_pricing_rules` ADD COLUMN `maxLengthIn` DECIMAL(10, 3) NOT NULL DEFAULT 288,
    ADD COLUMN `minLengthIn` DECIMAL(10, 3) NOT NULL DEFAULT 20;
