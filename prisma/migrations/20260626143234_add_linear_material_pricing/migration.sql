-- DropForeignKey
ALTER TABLE `Piece` DROP FOREIGN KEY `Piece_idCoat_fkey`;

-- DropForeignKey
ALTER TABLE `Piece` DROP FOREIGN KEY `Piece_idCryst_fkey`;

-- DropForeignKey
ALTER TABLE `Piece` DROP FOREIGN KEY `Piece_idTint_fkey`;

-- DropIndex
DROP INDEX `Piece_idCoat_fkey` ON `Piece`;

-- DropIndex
DROP INDEX `Piece_idCryst_fkey` ON `Piece`;

-- DropIndex
DROP INDEX `Piece_idTint_fkey` ON `Piece`;

-- AlterTable
ALTER TABLE `Piece` MODIFY `idCryst` INTEGER NULL,
    MODIFY `idTint` INTEGER NULL,
    MODIFY `privacy` BOOLEAN NOT NULL DEFAULT false,
    MODIFY `idCoat` INTEGER NULL,
    MODIFY `screen` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `Product` ADD COLUMN `kind` ENUM('GLAZED_UNIT', 'LINEAR_MATERIAL') NOT NULL DEFAULT 'GLAZED_UNIT',
    ADD COLUMN `pricingMode` ENUM('AREA_PERIMETER', 'LINEAR_INCH') NOT NULL DEFAULT 'AREA_PERIMETER';

-- CreateTable
CREATE TABLE `linear_pricing_rules` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `idBrand` INTEGER NOT NULL,
    `idProduct` INTEGER NOT NULL,
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `costPerInch` DECIMAL(18, 8) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `linear_pricing_rules_idProduct_idx`(`idProduct`),
    INDEX `linear_pricing_rules_idSystem_idConfig_idx`(`idSystem`, `idConfig`),
    UNIQUE INDEX `uq_linear_pricing_rule`(`idBrand`, `idProduct`, `idSystem`, `idConfig`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Product_kind_idx` ON `Product`(`kind`);

-- AddForeignKey
ALTER TABLE `linear_pricing_rules` ADD CONSTRAINT `linear_pricing_rules_idBrand_fkey` FOREIGN KEY (`idBrand`) REFERENCES `Brand`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `linear_pricing_rules` ADD CONSTRAINT `linear_pricing_rules_idProduct_fkey` FOREIGN KEY (`idProduct`) REFERENCES `Product`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `linear_pricing_rules` ADD CONSTRAINT `linear_pricing_rules_idSystem_fkey` FOREIGN KEY (`idSystem`) REFERENCES `System`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `linear_pricing_rules` ADD CONSTRAINT `linear_pricing_rules_idConfig_fkey` FOREIGN KEY (`idConfig`) REFERENCES `Config`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idCryst_fkey` FOREIGN KEY (`idCryst`) REFERENCES `Crystal`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idTint_fkey` FOREIGN KEY (`idTint`) REFERENCES `Tint`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idCoat_fkey` FOREIGN KEY (`idCoat`) REFERENCES `Coating`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
