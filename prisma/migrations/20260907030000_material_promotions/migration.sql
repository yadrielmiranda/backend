-- AlterTable
ALTER TABLE `Estimate` ADD COLUMN `customerDiscountAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `discountAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `originalCustomerPriceT` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `originalPriceT` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `promotionContext` JSON NULL,
    ADD COLUMN `promotionExpiresAt` DATETIME(3) NULL,
    ADD COLUMN `promotionLockedAt` DATETIME(3) NULL,
    ADD COLUMN `standardExpiresAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `Piece` ADD COLUMN `promotionSnapshot` JSON NULL,
    ADD COLUMN `regularCustomerPrice` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    ADD COLUMN `regularPrice` DECIMAL(12, 2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `Promotion` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(120) NOT NULL,
    `percent` DECIMAL(7, 4) NOT NULL,
    `audience` VARCHAR(10) NOT NULL,
    `roleId` INTEGER NULL,
    `userIds` JSON NOT NULL,
    `brandId` INTEGER NULL,
    `productId` INTEGER NULL,
    `systemId` INTEGER NULL,
    `startsAt` DATETIME(3) NOT NULL,
    `endsAt` DATETIME(3) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Promotion_enabled_startsAt_endsAt_idx`(`enabled`, `startsAt`, `endsAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;


-- Conserva precios y vencimientos de los estimados existentes.
UPDATE `Piece` SET `regularPrice` = `price`, `regularCustomerPrice` = `customerPrice`;
UPDATE `Estimate` SET `standardExpiresAt` = `expiresAt`, `originalPriceT` = `priceT`, `originalCustomerPriceT` = `customerPriceT`;
