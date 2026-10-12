-- One shared PO namespace prevents internal/external imports from claiming the same PO.
CREATE TABLE `factory_pos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `poNumber` VARCHAR(50) NOT NULL,
    `orderId` INTEGER NULL,
    `orderName` VARCHAR(200) NULL,
    `supplierName` VARCHAR(200) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `factory_pos_poNumber_key` (`poNumber`),
    UNIQUE INDEX `factory_pos_orderId_key` (`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Preserve existing orders and their PO ownership before accepting external stock.
INSERT INTO `factory_pos` (`poNumber`, `orderId`, `createdAt`, `updatedAt`)
SELECT `poNumber`, `id`, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM `Order` WHERE `poNumber` IS NOT NULL;

ALTER TABLE `factory_pos` ADD CONSTRAINT `factory_pos_orderId_fkey`
    FOREIGN KEY (`orderId`) REFERENCES `Order` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- The XOR check retains existing piece ownership and requires one source for every new unit.
-- Checked FK columns use RESTRICT because MySQL prohibits cascading updates on them.
ALTER TABLE `factory_units` DROP FOREIGN KEY `factory_units_pieceId_fkey`;
ALTER TABLE `factory_units`
    MODIFY `pieceId` INTEGER NULL,
    ADD COLUMN `externalPoId` INTEGER NULL,
    ADD COLUMN `mark` VARCHAR(200) NULL,
    ADD COLUMN `description` TEXT NULL,
    ADD COLUMN `panels` INTEGER NULL,
    ADD INDEX `factory_units_externalPoId_idx` (`externalPoId`),
    ADD CONSTRAINT `factory_units_one_source_chk`
        CHECK ((`pieceId` IS NOT NULL AND `externalPoId` IS NULL) OR (`pieceId` IS NULL AND `externalPoId` IS NOT NULL));
ALTER TABLE `factory_units` ADD CONSTRAINT `factory_units_pieceId_fkey`
    FOREIGN KEY (`pieceId`) REFERENCES `Piece` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `factory_units` ADD CONSTRAINT `factory_units_externalPoId_fkey`
    FOREIGN KEY (`externalPoId`) REFERENCES `factory_pos` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Keep every existing pickup membership and its uniqueness; surrogate IDs allow nullable sources.
ALTER TABLE `factory_pickup_run_orders` DROP FOREIGN KEY `factory_pickup_run_orders_orderId_fkey`;
ALTER TABLE `factory_pickup_run_orders`
    DROP PRIMARY KEY,
    ADD COLUMN `id` INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST,
    MODIFY `orderId` INTEGER NULL,
    ADD COLUMN `externalPoId` INTEGER NULL,
    ADD UNIQUE INDEX `factory_pickup_run_orders_pickupRunId_orderId_key` (`pickupRunId`, `orderId`),
    ADD UNIQUE INDEX `factory_pickup_run_orders_pickupRunId_externalPoId_key` (`pickupRunId`, `externalPoId`),
    ADD UNIQUE INDEX `factory_pickup_run_orders_externalPoId_activeSlot_key` (`externalPoId`, `activeSlot`),
    ADD CONSTRAINT `factory_pickup_run_orders_one_source_chk`
        CHECK ((`orderId` IS NOT NULL AND `externalPoId` IS NULL) OR (`orderId` IS NULL AND `externalPoId` IS NOT NULL));
ALTER TABLE `factory_pickup_run_orders` ADD CONSTRAINT `factory_pickup_run_orders_orderId_fkey`
    FOREIGN KEY (`orderId`) REFERENCES `Order` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `factory_pickup_run_orders` ADD CONSTRAINT `factory_pickup_run_orders_externalPoId_fkey`
    FOREIGN KEY (`externalPoId`) REFERENCES `factory_pos` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
