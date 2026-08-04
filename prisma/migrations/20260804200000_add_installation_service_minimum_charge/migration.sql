-- AlterTable
ALTER TABLE `installation_services`
    ADD COLUMN `minimumCharge` DECIMAL(12, 2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `installation_quotes`
    ADD COLUMN `serviceMinimumAdjustment` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `serviceMinimumsSnapshot` JSON NULL;
