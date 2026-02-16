/*
  Warnings:

  - A unique constraint covering the columns `[paymentId]` on the table `Order` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `paymentId` to the `Order` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `order` ADD COLUMN `paymentId` INTEGER NOT NULL;

-- CreateTable
CREATE TABLE `payments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `status` ENUM('PENDING', 'PAID', 'FAILED', 'CANCELED', 'EXPIRED', 'REFUNDED') NOT NULL DEFAULT 'PENDING',
    `idEst` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `currency` VARCHAR(10) NOT NULL DEFAULT 'usd',
    `stripeSessionId` VARCHAR(255) NULL,
    `stripePaymentIntentId` VARCHAR(255) NULL,
    `stripeCustomerId` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payments_idEst_key`(`idEst`),
    UNIQUE INDEX `payments_stripeSessionId_key`(`stripeSessionId`),
    UNIQUE INDEX `payments_stripePaymentIntentId_key`(`stripePaymentIntentId`),
    INDEX `payments_userId_idx`(`userId`),
    INDEX `payments_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `Order_paymentId_key` ON `Order`(`paymentId`);

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_paymentId_fkey` FOREIGN KEY (`paymentId`) REFERENCES `payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_idEst_fkey` FOREIGN KEY (`idEst`) REFERENCES `Estimate`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
