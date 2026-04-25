-- AlterTable
ALTER TABLE `system` ADD COLUMN `defaultCrystalId` INTEGER NULL;

-- CreateTable
CREATE TABLE `system_crystals` (
    `idSystem` INTEGER NOT NULL,
    `idCrystal` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `system_crystals_idCrystal_idx`(`idCrystal`),
    PRIMARY KEY (`idSystem`, `idCrystal`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `System_defaultCrystalId_idx` ON `System`(`defaultCrystalId`);

-- AddForeignKey
ALTER TABLE `System` ADD CONSTRAINT `System_defaultCrystalId_fkey` FOREIGN KEY (`defaultCrystalId`) REFERENCES `Crystal`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `system_crystals` ADD CONSTRAINT `system_crystals_idSystem_fkey` FOREIGN KEY (`idSystem`) REFERENCES `System`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `system_crystals` ADD CONSTRAINT `system_crystals_idCrystal_fkey` FOREIGN KEY (`idCrystal`) REFERENCES `Crystal`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
