-- AlterTable
ALTER TABLE `system` ADD COLUMN `defaultFrameColorId` INTEGER NULL;

-- CreateTable
CREATE TABLE `system_frame_colors` (
    `idSystem` INTEGER NOT NULL,
    `idFrameColor` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `system_frame_colors_idFrameColor_idx`(`idFrameColor`),
    PRIMARY KEY (`idSystem`, `idFrameColor`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `System_defaultFrameColorId_idx` ON `System`(`defaultFrameColorId`);

-- AddForeignKey
ALTER TABLE `System` ADD CONSTRAINT `System_defaultFrameColorId_fkey` FOREIGN KEY (`defaultFrameColorId`) REFERENCES `FrameColor`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `system_frame_colors` ADD CONSTRAINT `system_frame_colors_idSystem_fkey` FOREIGN KEY (`idSystem`) REFERENCES `System`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `system_frame_colors` ADD CONSTRAINT `system_frame_colors_idFrameColor_fkey` FOREIGN KEY (`idFrameColor`) REFERENCES `FrameColor`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
