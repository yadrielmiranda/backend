-- AlterTable
ALTER TABLE `estimate` ADD COLUMN `expiresAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `globalparameter` MODIFY `key` ENUM('SALES_TAX', 'ESTIMATE_VALID_DAYS') NOT NULL;
