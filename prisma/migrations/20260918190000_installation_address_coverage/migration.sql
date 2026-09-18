-- AlterTable
ALTER TABLE `installation_jobs` ADD COLUMN `installationAddress` JSON NULL,
    ADD COLUMN `installationAddressConfirmedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `installation_quotes` ADD COLUMN `installationSurcharge` DECIMAL(12, 2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `installation_quote_coverage_snapshots` (
    `quoteId` INTEGER NOT NULL,
    `data` JSON NOT NULL,

    PRIMARY KEY (`quoteId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `installation_quote_coverage_snapshots` ADD CONSTRAINT `installation_quote_coverage_snapshots_quoteId_fkey` FOREIGN KEY (`quoteId`) REFERENCES `installation_quotes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

