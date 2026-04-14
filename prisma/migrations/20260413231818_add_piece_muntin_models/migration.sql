/*
  Warnings:

  - You are about to drop the column `muntin` on the `piece` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE `piece` DROP COLUMN `muntin`;

-- CreateTable
CREATE TABLE `muntin_patterns` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `muntin_patterns_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `muntin_types` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `muntin_types_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `piece_muntins` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `pieceId` INTEGER NOT NULL,
    `patternId` INTEGER NOT NULL,
    `typeId` INTEGER NULL,
    `totalLites` INTEGER NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `piece_muntins_pieceId_key`(`pieceId`),
    INDEX `piece_muntins_patternId_idx`(`patternId`),
    INDEX `piece_muntins_typeId_idx`(`typeId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `piece_muntin_panels` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `pieceMuntinId` INTEGER NOT NULL,
    `panelIndex` INTEGER NOT NULL,
    `panelCode` VARCHAR(10) NOT NULL,
    `horizontalLites` INTEGER NOT NULL DEFAULT 1,
    `verticalLites` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `piece_muntin_panels_pieceMuntinId_idx`(`pieceMuntinId`),
    UNIQUE INDEX `uq_piece_muntin_panel_index`(`pieceMuntinId`, `panelIndex`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `piece_muntins` ADD CONSTRAINT `piece_muntins_pieceId_fkey` FOREIGN KEY (`pieceId`) REFERENCES `Piece`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `piece_muntins` ADD CONSTRAINT `piece_muntins_patternId_fkey` FOREIGN KEY (`patternId`) REFERENCES `muntin_patterns`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `piece_muntins` ADD CONSTRAINT `piece_muntins_typeId_fkey` FOREIGN KEY (`typeId`) REFERENCES `muntin_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `piece_muntin_panels` ADD CONSTRAINT `piece_muntin_panels_pieceMuntinId_fkey` FOREIGN KEY (`pieceMuntinId`) REFERENCES `piece_muntins`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER TABLE `piece` RENAME INDEX `Piece_idBrand_fkey` TO `Piece_idBrand_idx`;

-- RenameIndex
ALTER TABLE `piece` RENAME INDEX `Piece_idConf_fkey` TO `Piece_idConf_idx`;

-- RenameIndex
ALTER TABLE `piece` RENAME INDEX `Piece_idEst_fkey` TO `Piece_idEst_idx`;

-- RenameIndex
ALTER TABLE `piece` RENAME INDEX `Piece_idProd_fkey` TO `Piece_idProd_idx`;

-- RenameIndex
ALTER TABLE `piece` RENAME INDEX `Piece_idSyst_fkey` TO `Piece_idSyst_idx`;
