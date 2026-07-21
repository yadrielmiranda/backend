-- CreateTable
CREATE TABLE `pricing_ranges` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `code` VARCHAR(30) NOT NULL,
    `minWidthIn` DECIMAL(10, 3) NULL,
    `minWidthInclusive` BOOLEAN NOT NULL DEFAULT true,
    `maxWidthIn` DECIMAL(10, 3) NULL,
    `maxWidthInclusive` BOOLEAN NOT NULL DEFAULT true,
    `minHeightIn` DECIMAL(10, 3) NULL,
    `minHeightInclusive` BOOLEAN NOT NULL DEFAULT true,
    `maxHeightIn` DECIMAL(10, 3) NULL,
    `maxHeightInclusive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `idx_pricing_range_sysconf_active`(`idSystem`, `idConfig`, `isActive`),
    UNIQUE INDEX `uq_pricing_range_sysconf_code`(`idSystem`, `idConfig`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pricing_range_rules` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `rangeId` INTEGER NOT NULL,
    `idCrystal` INTEGER NOT NULL,
    `costoA` DECIMAL(24, 20) NOT NULL,
    `costoB` DECIMAL(24, 20) NOT NULL,
    `costoC` DECIMAL(24, 20) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `idx_pricing_range_rule_crystal`(`idCrystal`),
    UNIQUE INDEX `uq_pricing_range_rule_range_crystal`(`rangeId`, `idCrystal`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `pricing_ranges` ADD CONSTRAINT `pricing_ranges_idSystem_idConfig_fkey` FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf`(`idSystem`, `idConfig`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pricing_range_rules` ADD CONSTRAINT `pricing_range_rules_rangeId_fkey` FOREIGN KEY (`rangeId`) REFERENCES `pricing_ranges`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `pricing_range_rules` ADD CONSTRAINT `pricing_range_rules_idCrystal_fkey` FOREIGN KEY (`idCrystal`) REFERENCES `Crystal`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
