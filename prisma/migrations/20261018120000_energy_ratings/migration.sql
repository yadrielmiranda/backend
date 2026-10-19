CREATE TABLE `energy_ratings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `idSystem` INTEGER NOT NULL,
    `idCrystal` INTEGER NOT NULL,
    `idTint` INTEGER NOT NULL,
    `idCoating` INTEGER NOT NULL,
    `idPrivacy` INTEGER NOT NULL,
    `idConfig` INTEGER NULL,
    `appliesToAllConfigs` BOOLEAN NOT NULL DEFAULT false,
    `uFactor` DECIMAL(10,6) NULL,
    `shgc` DECIMAL(10,6) NULL,
    `vlt` DECIMAL(10,6) NULL,
    `units` VARCHAR(30) NOT NULL DEFAULT 'U_FACTOR_IP',
    `sourceFile` VARCHAR(255) NULL,
    `sourceSheet` VARCHAR(100) NULL,
    `sourceRow` INTEGER NULL,
    `sourceVersion` VARCHAR(100) NULL,
    `sourceGlassId` VARCHAR(100) NULL,
    `composition` TEXT NULL,
    `notes` TEXT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `activeKey` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `energy_ratings_activeKey_key`(`activeKey`),
    INDEX `energy_rating_lookup_idx`(`idSystem`, `idCrystal`, `idTint`, `idCoating`, `idPrivacy`, `isActive`),
    INDEX `energy_ratings_idConfig_idx`(`idConfig`),
    INDEX `energy_ratings_idTint_idx`(`idTint`),
    INDEX `energy_ratings_idCoating_idx`(`idCoating`),
    INDEX `energy_ratings_idPrivacy_idx`(`idPrivacy`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `Piece` ADD COLUMN `energyRatingId` INTEGER NULL, ADD COLUMN `energySnapshot` JSON NULL;
CREATE INDEX `Piece_energyRatingId_idx` ON `Piece`(`energyRatingId`);
ALTER TABLE `energy_ratings` ADD CONSTRAINT `energy_ratings_idSystem_idCrystal_fkey` FOREIGN KEY (`idSystem`, `idCrystal`) REFERENCES `system_crystals`(`idSystem`, `idCrystal`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `energy_ratings` ADD CONSTRAINT `energy_ratings_idConfig_fkey` FOREIGN KEY (`idConfig`) REFERENCES `Config`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `energy_ratings` ADD CONSTRAINT `energy_ratings_idTint_fkey` FOREIGN KEY (`idTint`) REFERENCES `Tint`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `energy_ratings` ADD CONSTRAINT `energy_ratings_idCoating_fkey` FOREIGN KEY (`idCoating`) REFERENCES `Coating`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `energy_ratings` ADD CONSTRAINT `energy_ratings_idPrivacy_fkey` FOREIGN KEY (`idPrivacy`) REFERENCES `Privacy`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_energyRatingId_fkey` FOREIGN KEY (`energyRatingId`) REFERENCES `energy_ratings`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
