-- Ubicaciones internas configurables. No se crean Store 1 / Store 2 automáticamente.
CREATE TABLE `warehouse_stores` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(80) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `warehouse_stores_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `warehouse_store_stock` (
    `lineNumber` VARCHAR(50) NOT NULL,
    `storeId` INTEGER NOT NULL,
    `onHand` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `warehouse_store_stock_storeId_onHand_idx`(`storeId`, `onHand`),
    PRIMARY KEY (`lineNumber`, `storeId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `warehouse_movements`
    MODIFY `type` ENUM('COLLECT', 'RECEIVE', 'RELEASE', 'ADJUST', 'PARTS', 'UNDO', 'COUNT', 'COUNT_UNDO', 'TRANSFER') NOT NULL,
    ADD COLUMN `quantity` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `fromStoreId` INTEGER NULL,
    ADD COLUMN `toStoreId` INTEGER NULL;

-- Solo se completa el dato descriptivo de movimientos existentes, no sus saldos.
UPDATE `warehouse_movements`
SET `quantity` = GREATEST(ABS(`transitDelta`), ABS(`onHandDelta`), ABS(`releasedDelta`), ABS(`countDelta`));

CREATE INDEX `warehouse_movements_fromStoreId_id_idx` ON `warehouse_movements`(`fromStoreId`, `id`);
CREATE INDEX `warehouse_movements_toStoreId_id_idx` ON `warehouse_movements`(`toStoreId`, `id`);

ALTER TABLE `warehouse_counts`
    ADD COLUMN `scope` ENUM('ALL', 'STORE', 'UNASSIGNED') NOT NULL DEFAULT 'ALL',
    ADD COLUMN `storeId` INTEGER NULL;
CREATE INDEX `warehouse_counts_storeId_idx` ON `warehouse_counts`(`storeId`);

ALTER TABLE `warehouse_store_stock` ADD CONSTRAINT `warehouse_store_stock_lineNumber_fkey`
    FOREIGN KEY (`lineNumber`) REFERENCES `warehouse_stock`(`lineNumber`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `warehouse_store_stock` ADD CONSTRAINT `warehouse_store_stock_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `warehouse_stores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `warehouse_movements` ADD CONSTRAINT `warehouse_movements_fromStoreId_fkey`
    FOREIGN KEY (`fromStoreId`) REFERENCES `warehouse_stores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `warehouse_movements` ADD CONSTRAINT `warehouse_movements_toStoreId_fkey`
    FOREIGN KEY (`toStoreId`) REFERENCES `warehouse_stores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `warehouse_counts` ADD CONSTRAINT `warehouse_counts_storeId_fkey`
    FOREIGN KEY (`storeId`) REFERENCES `warehouse_stores`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Se conserva onHand y se identifica su ubicación desconocida sin crear movimientos.
ALTER TABLE `warehouse_stock` ADD COLUMN `unassigned` INTEGER NOT NULL DEFAULT 0;
UPDATE `warehouse_stock` SET `unassigned` = `onHand`;
CREATE INDEX `warehouse_stock_unassigned_idx` ON `warehouse_stock`(`unassigned`);
