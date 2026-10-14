CREATE TABLE `warehouse_customer_deliveries` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `requestKey` VARCHAR(64) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `source` VARCHAR(20) NOT NULL,
    `storeId` INTEGER NULL,
    `storeName` VARCHAR(80) NULL,
    `firstName` VARCHAR(100) NOT NULL,
    `lastName` VARCHAR(100) NOT NULL,
    `signatureStrokes` JSON NOT NULL,
    `items` JSON NOT NULL,
    `totalPieces` INTEGER NOT NULL,
    `totalParts` INTEGER NOT NULL,
    `actorId` INTEGER NOT NULL,
    `actorName` VARCHAR(255) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `warehouse_customer_deliveries_requestKey_key`(`requestKey`),
    INDEX `warehouse_customer_deliveries_storeId_id_idx`(`storeId`, `id`),
    INDEX `warehouse_customer_deliveries_actorId_idx`(`actorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `warehouse_customer_deliveries` ADD CONSTRAINT `warehouse_customer_deliveries_storeId_fkey` FOREIGN KEY (`storeId`) REFERENCES `warehouse_stores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `warehouse_customer_deliveries` ADD CONSTRAINT `warehouse_customer_deliveries_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `warehouse_movements` ADD COLUMN `customerDeliveryId` INTEGER NULL;
CREATE INDEX `warehouse_movements_customerDeliveryId_id_idx` ON `warehouse_movements`(`customerDeliveryId`, `id`);
ALTER TABLE `warehouse_movements` ADD CONSTRAINT `warehouse_movements_customerDeliveryId_fkey` FOREIGN KEY (`customerDeliveryId`) REFERENCES `warehouse_customer_deliveries`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
