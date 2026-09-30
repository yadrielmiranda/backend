-- Only new checkouts receive an allocation snapshot. Historical receipts remain NULL.
ALTER TABLE `Estimate`
    ADD COLUMN `materialProcessingCost` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `materialProcessingCostPending` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `payments` ADD COLUMN `processingCostSnapshot` JSON NULL;
ALTER TABLE `payment_receipts` ADD COLUMN `processingCostSnapshot` JSON NULL;

CREATE TABLE `stripe_processing_costs` (
    `stripeChargeId` VARCHAR(255) NOT NULL,
    `estimateId` INTEGER NOT NULL,
    `currency` VARCHAR(10) NOT NULL,
    `capturedAmount` DECIMAL(12, 2) NOT NULL,
    `fee` DECIMAL(12, 2) NULL,
    `materialFee` DECIMAL(12, 2) NULL,
    `materialSurcharge` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `balanceTransactionId` VARCHAR(255) NULL,
    `allocationSnapshot` JSON NOT NULL,
    `status` VARCHAR(20) NOT NULL,
    `lastError` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `stripe_processing_costs_estimateId_idx` (`estimateId`),
    INDEX `stripe_processing_costs_status_updatedAt_idx` (`status`, `updatedAt`),
    PRIMARY KEY (`stripeChargeId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `stripe_processing_costs` ADD CONSTRAINT `stripe_processing_costs_estimateId_fkey`
    FOREIGN KEY (`estimateId`) REFERENCES `Estimate`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
