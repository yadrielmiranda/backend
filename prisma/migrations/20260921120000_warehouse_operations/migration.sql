-- CreateTable
CREATE TABLE `warehouse_stock` (
    `lineNumber` VARCHAR(50) NOT NULL,
    `expectedParts` INTEGER NULL,
    `inTransit` INTEGER NOT NULL DEFAULT 0,
    `onHand` INTEGER NOT NULL DEFAULT 0,
    `released` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `warehouse_stock_onHand_idx`(`onHand`),
    INDEX `warehouse_stock_inTransit_idx`(`inTransit`),
    PRIMARY KEY (`lineNumber`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `warehouse_movements` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `requestKey` VARCHAR(64) NOT NULL,
    `requestHash` CHAR(64) NOT NULL,
    `lineNumber` VARCHAR(50) NOT NULL,
    `type` ENUM('COLLECT', 'RECEIVE', 'RELEASE', 'ADJUST', 'PARTS', 'UNDO', 'COUNT', 'COUNT_UNDO') NOT NULL,
    `transitDelta` INTEGER NOT NULL DEFAULT 0,
    `onHandDelta` INTEGER NOT NULL DEFAULT 0,
    `releasedDelta` INTEGER NOT NULL DEFAULT 0,
    `transitAfter` INTEGER NOT NULL,
    `onHandAfter` INTEGER NOT NULL,
    `releasedAfter` INTEGER NOT NULL,
    `expectedPartsBefore` INTEGER NULL,
    `expectedPartsAfter` INTEGER NULL,
    `stockVersionAfter` INTEGER NOT NULL,
    `reason` VARCHAR(500) NULL,
    `actorId` INTEGER NOT NULL,
    `reversalOfId` INTEGER NULL,
    `countId` INTEGER NULL,
    `countDelta` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `warehouse_movements_requestKey_key`(`requestKey`),
    UNIQUE INDEX `warehouse_movements_reversalOfId_key`(`reversalOfId`),
    INDEX `warehouse_movements_lineNumber_id_idx`(`lineNumber`, `id`),
    INDEX `warehouse_movements_actorId_idx`(`actorId`),
    INDEX `warehouse_movements_countId_idx`(`countId`),
    INDEX `warehouse_movements_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `warehouse_counts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `requestKey` VARCHAR(64) NOT NULL,
    `activeSlot` INTEGER NULL,
    `status` ENUM('OPEN', 'COMPLETED', 'CANCELED') NOT NULL DEFAULT 'OPEN',
    `startedById` INTEGER NOT NULL,
    `closedById` INTEGER NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closedAt` DATETIME(3) NULL,
    `reason` VARCHAR(500) NULL,

    UNIQUE INDEX `warehouse_counts_requestKey_key`(`requestKey`),
    UNIQUE INDEX `warehouse_counts_activeSlot_key`(`activeSlot`),
    INDEX `warehouse_counts_startedById_idx`(`startedById`),
    INDEX `warehouse_counts_closedById_idx`(`closedById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `warehouse_count_lines` (
    `countId` INTEGER NOT NULL,
    `lineNumber` VARCHAR(50) NOT NULL,
    `expected` INTEGER NOT NULL,
    `counted` INTEGER NOT NULL DEFAULT 0,
    `stockVersion` INTEGER NOT NULL,

    INDEX `warehouse_count_lines_lineNumber_idx`(`lineNumber`),
    PRIMARY KEY (`countId`, `lineNumber`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `warehouse_stock` ADD CONSTRAINT `warehouse_stock_lineNumber_fkey` FOREIGN KEY (`lineNumber`) REFERENCES `factory_units`(`lineNumber`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warehouse_movements` ADD CONSTRAINT `warehouse_movements_lineNumber_fkey` FOREIGN KEY (`lineNumber`) REFERENCES `warehouse_stock`(`lineNumber`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warehouse_movements` ADD CONSTRAINT `warehouse_movements_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warehouse_movements` ADD CONSTRAINT `warehouse_movements_reversalOfId_fkey` FOREIGN KEY (`reversalOfId`) REFERENCES `warehouse_movements`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `warehouse_movements` ADD CONSTRAINT `warehouse_movements_countId_fkey` FOREIGN KEY (`countId`) REFERENCES `warehouse_counts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warehouse_counts` ADD CONSTRAINT `warehouse_counts_startedById_fkey` FOREIGN KEY (`startedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warehouse_counts` ADD CONSTRAINT `warehouse_counts_closedById_fkey` FOREIGN KEY (`closedById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warehouse_count_lines` ADD CONSTRAINT `warehouse_count_lines_countId_fkey` FOREIGN KEY (`countId`) REFERENCES `warehouse_counts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `warehouse_count_lines` ADD CONSTRAINT `warehouse_count_lines_lineNumber_fkey` FOREIGN KEY (`lineNumber`) REFERENCES `warehouse_stock`(`lineNumber`) ON DELETE RESTRICT ON UPDATE CASCADE;


-- Los códigos previamente importados empiezan sin existencias: importar no equivale a recibir.
INSERT INTO `warehouse_stock` (`lineNumber`, `expectedParts`, `inTransit`, `onHand`, `released`, `version`, `updatedAt`)
SELECT `lineNumber`, NULL, 0, 0, 0, 0, CURRENT_TIMESTAMP(3) FROM `factory_units`;
