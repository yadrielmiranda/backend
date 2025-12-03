-- CreateTable
CREATE TABLE `dimension_policy` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `idCrystal` INTEGER NOT NULL,
    `sizeBasis` ENUM('FRAME', 'DLO') NOT NULL DEFAULT 'FRAME',
    `roundingRule` ENUM('ROUND_UP_TO_NEXT', 'NEAREST') NOT NULL DEFAULT 'ROUND_UP_TO_NEXT',
    `notes` VARCHAR(191) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_policy_sysconf_crystal`(`idSystem`, `idConfig`, `idCrystal`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dimension_rule` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `idPolicy` INTEGER NOT NULL,
    `minWidthIn` DECIMAL(10, 4) NOT NULL,
    `maxWidthIn` DECIMAL(10, 4) NOT NULL,
    `minHeightIn` DECIMAL(10, 4) NOT NULL,
    `maxHeightIn` DECIMAL(10, 4) NOT NULL,
    `dpPosPsf` DECIMAL(10, 2) NOT NULL,
    `dpNegPsf` DECIMAL(10, 2) NOT NULL,
    `anchorsPerJamb` INTEGER NULL,
    `extraAnchorFlag` BOOLEAN NOT NULL DEFAULT false,
    `note` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `dimension_rule_idPolicy_idx`(`idPolicy`),
    INDEX `dimension_rule_minWidthIn_maxWidthIn_minHeightIn_maxHeightIn_idx`(`minWidthIn`, `maxWidthIn`, `minHeightIn`, `maxHeightIn`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `dimension_policy` ADD CONSTRAINT `dimension_policy_idSystem_idConfig_fkey` FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf`(`idSystem`, `idConfig`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dimension_policy` ADD CONSTRAINT `dimension_policy_idCrystal_fkey` FOREIGN KEY (`idCrystal`) REFERENCES `Crystal`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dimension_rule` ADD CONSTRAINT `dimension_rule_idPolicy_fkey` FOREIGN KEY (`idPolicy`) REFERENCES `dimension_policy`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
