-- Recogidas de fábrica organizadas por visita. Los movimientos físicos existentes se conservan.
CREATE TABLE `factory_pickup_runs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `technicianId` INTEGER NOT NULL,
    `status` ENUM('ACTIVE', 'COMPLETED', 'PARTIAL') NOT NULL DEFAULT 'ACTIVE',
    `activeSlot` INTEGER NULL DEFAULT 1,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `partialReason` ENUM('NOT_READY_AT_FACTORY', 'MANUFACTURER_HELD_MATERIAL', 'DAMAGED_NOT_ACCEPTED', 'OTHER') NULL,
    `note` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `factory_pickup_runs_technicianId_activeSlot_key`(`technicianId`, `activeSlot`),
    INDEX `factory_pickup_runs_status_startedAt_idx`(`status`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `factory_pickup_run_orders` (
    `pickupRunId` INTEGER NOT NULL,
    `orderId` INTEGER NOT NULL,
    `activeSlot` INTEGER NULL DEFAULT 1,
    `addedDuringPickup` BOOLEAN NOT NULL DEFAULT false,
    `addedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `factory_pickup_run_orders_orderId_activeSlot_key`(`orderId`, `activeSlot`),
    INDEX `factory_pickup_run_orders_pickupRunId_addedAt_idx`(`pickupRunId`, `addedAt`),
    PRIMARY KEY (`pickupRunId`, `orderId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `factory_pickup_run_lines` (
    `pickupRunId` INTEGER NOT NULL,
    `lineNumber` VARCHAR(50) NOT NULL,
    `targetParts` INTEGER NOT NULL,
    `addedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX `factory_pickup_run_lines_lineNumber_idx`(`lineNumber`),
    PRIMARY KEY (`pickupRunId`, `lineNumber`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `warehouse_movements`
    ADD COLUMN `pickupRunId` INTEGER NULL;
CREATE INDEX `warehouse_movements_pickupRunId_id_idx` ON `warehouse_movements`(`pickupRunId`, `id`);

ALTER TABLE `factory_pickup_runs` ADD CONSTRAINT `factory_pickup_runs_technicianId_fkey`
    FOREIGN KEY (`technicianId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `factory_pickup_run_orders` ADD CONSTRAINT `factory_pickup_run_orders_pickupRunId_fkey`
    FOREIGN KEY (`pickupRunId`) REFERENCES `factory_pickup_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `factory_pickup_run_orders` ADD CONSTRAINT `factory_pickup_run_orders_orderId_fkey`
    FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `factory_pickup_run_lines` ADD CONSTRAINT `factory_pickup_run_lines_pickupRunId_fkey`
    FOREIGN KEY (`pickupRunId`) REFERENCES `factory_pickup_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `factory_pickup_run_lines` ADD CONSTRAINT `factory_pickup_run_lines_lineNumber_fkey`
    FOREIGN KEY (`lineNumber`) REFERENCES `warehouse_stock`(`lineNumber`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `warehouse_movements` ADD CONSTRAINT `warehouse_movements_pickupRunId_fkey`
    FOREIGN KEY (`pickupRunId`) REFERENCES `factory_pickup_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
