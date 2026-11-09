-- CreateTable
CREATE TABLE `factory_manufacturers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(150) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `factory_manufacturers_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `factory_payments_settings` (
    `id` INTEGER NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `factory_payment_accounts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `orderId` INTEGER NOT NULL,
    `manufacturerId` INTEGER NOT NULL,
    `poNumber` VARCHAR(50) NOT NULL,
    `sourceCost` DECIMAL(18, 8) NOT NULL,
    `total` DECIMAL(12, 2) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `factory_payment_accounts_orderId_key`(`orderId`),
    UNIQUE INDEX `factory_payment_accounts_manufacturerId_poNumber_key`(`manufacturerId`, `poNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `factory_payments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `accountId` INTEGER NOT NULL,
    `requestId` VARCHAR(36) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `paidOn` DATE NOT NULL,
    `invoiceNumber` VARCHAR(100) NOT NULL,
    `kind` ENUM('DEPOSIT', 'PARTIAL', 'FINAL', 'OTHER') NOT NULL,
    `reference` VARCHAR(150) NULL,
    `note` TEXT NULL,
    `createdById` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `voidedAt` DATETIME(3) NULL,
    `voidedById` INTEGER NULL,
    `voidReason` VARCHAR(500) NULL,

    UNIQUE INDEX `factory_payments_requestId_key`(`requestId`),
    INDEX `factory_payments_accountId_paidOn_idx`(`accountId`, `paidOn`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `factory_payment_events` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `accountId` INTEGER NULL,
    `manufacturerId` INTEGER NULL,
    `action` VARCHAR(50) NOT NULL,
    `detail` TEXT NOT NULL,
    `data` JSON NULL,
    `actorId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `factory_payment_events_accountId_createdAt_idx`(`accountId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `factory_payment_accounts` ADD CONSTRAINT `factory_payment_accounts_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `factory_payment_accounts` ADD CONSTRAINT `factory_payment_accounts_manufacturerId_fkey` FOREIGN KEY (`manufacturerId`) REFERENCES `factory_manufacturers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `factory_payments` ADD CONSTRAINT `factory_payments_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `factory_payment_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `factory_payment_events` ADD CONSTRAINT `factory_payment_events_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `factory_payment_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Editable starting catalog; no existing orders or financial records are changed.
INSERT INTO `factory_manufacturers` (`name`, `active`, `isDefault`, `updatedAt`)
VALUES ('Eco Window Systems', true, true, CURRENT_TIMESTAMP(3));
INSERT INTO `factory_payments_settings` (`id`) VALUES (1);
