-- AlterTable
ALTER TABLE `payments` ADD COLUMN `netPaidBaseAmount` DECIMAL(12, 2) NULL,
    ADD COLUMN `originalBaseAmount` DECIMAL(12, 2) NULL,
    ADD COLUMN `paymentMethodLabel` VARCHAR(80) NULL,
    ADD COLUMN `refundCreditAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `refundReviewBaseAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `refundReviewPending` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `refundedAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `stripeFundingSourceGroup` VARCHAR(80) NULL,
    ADD COLUMN `stripeMethodType` VARCHAR(80) NULL,
    MODIFY `paymentMethod` ENUM('CARD', 'BANK', 'CHECK', 'ZELLE', 'CASH', 'ACH', 'WIRE', 'OTHER') NOT NULL DEFAULT 'OTHER';

-- CreateTable
CREATE TABLE `payment_receipts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `paymentId` INTEGER NOT NULL,
    `sourceKey` VARCHAR(255) NOT NULL,
    `stripeChargeId` VARCHAR(255) NULL,
    `stripePaymentIntentId` VARCHAR(255) NULL,
    `stripeSessionId` VARCHAR(255) NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `baseAmount` DECIMAL(12, 2) NOT NULL,
    `surchargeAmount` DECIMAL(12, 2) NOT NULL,
    `currency` VARCHAR(10) NOT NULL,
    `paymentMethod` ENUM('CARD', 'BANK', 'CHECK', 'ZELLE', 'CASH', 'ACH', 'WIRE', 'OTHER') NOT NULL,
    `paymentMethodLabel` VARCHAR(80) NULL,
    `stripeMethodType` VARCHAR(80) NULL,
    `stripeFundingSourceGroup` VARCHAR(80) NULL,
    `paidAt` DATETIME(3) NOT NULL,
    `manualReference` VARCHAR(150) NULL,
    `manualNote` VARCHAR(1000) NULL,
    `recordedById` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payment_receipts_sourceKey_key`(`sourceKey`),
    INDEX `payment_receipts_paymentId_idx`(`paymentId`),
    INDEX `payment_receipts_stripeChargeId_idx`(`stripeChargeId`),
    INDEX `payment_receipts_stripePaymentIntentId_idx`(`stripePaymentIntentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_refunds` (
    `id` VARCHAR(255) NOT NULL,
    `stripeChargeId` VARCHAR(255) NOT NULL,
    `stripePaymentIntentId` VARCHAR(255) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `currency` VARCHAR(10) NOT NULL,
    `status` VARCHAR(30) NOT NULL,
    `reason` VARCHAR(80) NULL,
    `failureReason` VARCHAR(255) NULL,
    `stripeCreatedAt` DATETIME(3) NOT NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewedById` INTEGER NULL,
    `reviewNote` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `payment_refunds_stripeChargeId_idx`(`stripeChargeId`),
    INDEX `payment_refunds_stripePaymentIntentId_idx`(`stripePaymentIntentId`),
    INDEX `payment_refunds_status_updatedAt_idx`(`status`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_refund_allocations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `refundId` VARCHAR(255) NOT NULL,
    `receiptId` INTEGER NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `baseAmount` DECIMAL(12, 2) NOT NULL,
    `creditAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,

    INDEX `payment_refund_allocations_receiptId_idx`(`receiptId`),
    UNIQUE INDEX `payment_refund_allocations_refundId_receiptId_key`(`refundId`, `receiptId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `payment_receipts` ADD CONSTRAINT `payment_receipts_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_refund_allocations` ADD CONSTRAINT `payment_refund_allocations_refundId_fkey` FOREIGN KEY (`refundId`) REFERENCES `payment_refunds`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payment_refund_allocations` ADD CONSTRAINT `payment_refund_allocations_receiptId_fkey` FOREIGN KEY (`receiptId`) REFERENCES `payment_receipts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

