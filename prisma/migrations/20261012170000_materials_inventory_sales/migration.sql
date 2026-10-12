-- CreateTable
CREATE TABLE `material_units` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(80) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `material_units_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `material_products` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `description` TEXT NULL,
    `baseUnitId` INTEGER NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `isSaleEnabled` BOOLEAN NOT NULL DEFAULT false,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `material_products_code_key`(`code`),
    INDEX `material_products_isActive_isSaleEnabled_idx`(`isActive`, `isSaleEnabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `material_presentations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `productId` INTEGER NOT NULL,
    `unitId` INTEGER NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `multiplier` INTEGER NOT NULL,
    `barcode` VARCHAR(120) NULL,
    `isBase` BOOLEAN NOT NULL DEFAULT false,
    `isPurchase` BOOLEAN NOT NULL DEFAULT false,
    `isSaleEnabled` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `salePrice` DECIMAL(12, 2) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `material_presentations_barcode_key`(`barcode`),
    UNIQUE INDEX `material_presentations_productId_unitId_multiplier_key`(`productId`, `unitId`, `multiplier`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `material_stock` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `productId` INTEGER NOT NULL,
    `presentationId` INTEGER NOT NULL,
    `storeId` INTEGER NOT NULL,
    `quantity` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `material_stock_productId_storeId_idx`(`productId`, `storeId`),
    UNIQUE INDEX `material_stock_presentationId_storeId_key`(`presentationId`, `storeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `material_operations` (
    `requestKey` VARCHAR(64) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `kind` VARCHAR(40) NOT NULL,
    `actorId` INTEGER NULL,
    `result` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`requestKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `material_movements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `operationKey` VARCHAR(64) NOT NULL,
    `productId` INTEGER NOT NULL,
    `presentationId` INTEGER NULL,
    `storeId` INTEGER NOT NULL,
    `kind` VARCHAR(40) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `deltaBaseUnits` INTEGER NOT NULL,
    `baseUnitsAfter` INTEGER NOT NULL,
    `costPerPackage` DECIMAL(12, 2) NULL,
    `totalCost` DECIMAL(12, 2) NULL,
    `supplier` VARCHAR(200) NULL,
    `reference` VARCHAR(200) NULL,
    `note` VARCHAR(1000) NULL,
    `recipient` VARCHAR(200) NULL,
    `actorId` INTEGER NULL,
    `details` JSON NULL,
    `saleId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `material_movements_productId_storeId_id_idx`(`productId`, `storeId`, `id`),
    INDEX `material_movements_saleId_idx`(`saleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `material_sales` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL,
    `publicToken` VARCHAR(100) NOT NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
    `storeId` INTEGER NOT NULL,
    `customerName` VARCHAR(200) NOT NULL,
    `customerEmail` VARCHAR(200) NULL,
    `customerPhone` VARCHAR(40) NULL,
    `note` VARCHAR(1000) NULL,
    `subtotal` DECIMAL(12, 2) NOT NULL,
    `discountAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `taxRate` DECIMAL(10, 4) NOT NULL DEFAULT 0,
    `taxAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `total` DECIMAL(12, 2) NOT NULL,
    `paidAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `currency` VARCHAR(10) NOT NULL DEFAULT 'usd',
    `requireFullPayment` BOOLEAN NOT NULL DEFAULT true,
    `createdById` INTEGER NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `expiresAt` DATETIME(3) NULL,
    `confirmedAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `canceledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `material_sales_code_key`(`code`),
    UNIQUE INDEX `material_sales_publicToken_key`(`publicToken`),
    INDEX `material_sales_status_storeId_idx`(`status`, `storeId`),
    INDEX `material_sales_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `material_sale_lines` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `saleId` INTEGER NOT NULL,
    `storeId` INTEGER NOT NULL,
    `productId` INTEGER NOT NULL,
    `presentationId` INTEGER NOT NULL,
    `productName` VARCHAR(200) NOT NULL,
    `presentationName` VARCHAR(120) NOT NULL,
    `productCode` VARCHAR(50) NOT NULL,
    `multiplier` INTEGER NOT NULL,
    `quantity` INTEGER NOT NULL,
    `unitPrice` DECIMAL(12, 2) NOT NULL,
    `lineTotal` DECIMAL(12, 2) NOT NULL,

    INDEX `material_sale_lines_productId_saleId_idx`(`productId`, `saleId`),
    INDEX `material_sale_lines_presentationId_idx`(`presentationId`),
    INDEX `material_sale_lines_storeId_productId_idx`(`storeId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `material_payments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `saleId` INTEGER NOT NULL,
    `requestKey` VARCHAR(64) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'PENDING',
    `source` VARCHAR(20) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `refundedAmount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `currency` VARCHAR(10) NOT NULL DEFAULT 'usd',
    `paymentMethod` ENUM('CARD', 'BANK', 'CHECK', 'ZELLE', 'CASH', 'ACH', 'WIRE', 'OTHER') NOT NULL DEFAULT 'OTHER',
    `reference` VARCHAR(200) NULL,
    `note` VARCHAR(1000) NULL,
    `recordedById` INTEGER NULL,
    `stripeSessionId` VARCHAR(255) NULL,
    `stripePaymentIntentId` VARCHAR(255) NULL,
    `stripeChargeId` VARCHAR(255) NULL,
    `checkoutUrl` TEXT NULL,
    `expiresAt` DATETIME(3) NULL,
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `material_payments_requestKey_key`(`requestKey`),
    UNIQUE INDEX `material_payments_stripeSessionId_key`(`stripeSessionId`),
    UNIQUE INDEX `material_payments_stripePaymentIntentId_key`(`stripePaymentIntentId`),
    UNIQUE INDEX `material_payments_stripeChargeId_key`(`stripeChargeId`),
    INDEX `material_payments_saleId_status_idx`(`saleId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `material_products` ADD CONSTRAINT `material_products_baseUnitId_fkey` FOREIGN KEY (`baseUnitId`) REFERENCES `material_units`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_presentations` ADD CONSTRAINT `material_presentations_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `material_products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_presentations` ADD CONSTRAINT `material_presentations_unitId_fkey` FOREIGN KEY (`unitId`) REFERENCES `material_units`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_stock` ADD CONSTRAINT `material_stock_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `material_products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_stock` ADD CONSTRAINT `material_stock_presentationId_fkey` FOREIGN KEY (`presentationId`) REFERENCES `material_presentations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_stock` ADD CONSTRAINT `material_stock_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `warehouse_stores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_movements` ADD CONSTRAINT `material_movements_operationKey_fkey` FOREIGN KEY (`operationKey`) REFERENCES `material_operations`(`requestKey`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_movements` ADD CONSTRAINT `material_movements_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `material_products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_movements` ADD CONSTRAINT `material_movements_presentationId_fkey` FOREIGN KEY (`presentationId`) REFERENCES `material_presentations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_movements` ADD CONSTRAINT `material_movements_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `warehouse_stores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_movements` ADD CONSTRAINT `material_movements_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `material_sales`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_sales` ADD CONSTRAINT `material_sales_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `warehouse_stores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_sale_lines` ADD CONSTRAINT `material_sale_lines_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `material_sales`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_sale_lines` ADD CONSTRAINT `material_sale_lines_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `warehouse_stores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_sale_lines` ADD CONSTRAINT `material_sale_lines_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `material_products`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_sale_lines` ADD CONSTRAINT `material_sale_lines_presentationId_fkey` FOREIGN KEY (`presentationId`) REFERENCES `material_presentations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `material_payments` ADD CONSTRAINT `material_payments_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `material_sales`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
