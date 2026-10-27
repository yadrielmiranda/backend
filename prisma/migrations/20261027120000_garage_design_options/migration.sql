CREATE TABLE `design_patterns` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(50) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `imageUrl` VARCHAR(2048) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `design_patterns_code_key`(`code`),
    INDEX `design_patterns_isActive_sortOrder_idx`(`isActive`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `design_colors` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `hexCode` VARCHAR(7) NOT NULL DEFAULT '#FFFFFF',
    `textureUrl` VARCHAR(2048) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `design_colors_name_key`(`name`),
    INDEX `design_colors_isActive_sortOrder_idx`(`isActive`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `system_design_options` (
    `idSystem` INTEGER NOT NULL,
    `idDesign` INTEGER NOT NULL,
    `idDesignColor` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    INDEX `system_design_options_idDesign_idx`(`idDesign`),
    INDEX `system_design_options_idDesignColor_idx`(`idDesignColor`),
    PRIMARY KEY (`idSystem`, `idDesign`, `idDesignColor`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `System`
    ADD COLUMN `allowDesign` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `defaultDesignId` INTEGER NULL,
    ADD COLUMN `defaultDesignColorId` INTEGER NULL;

ALTER TABLE `Piece`
    ADD COLUMN `idDesign` INTEGER NULL,
    ADD COLUMN `idDesignColor` INTEGER NULL,
    ADD COLUMN `designSnapshot` JSON NULL;

CREATE INDEX `System_defaultDesignId_idx` ON `System`(`defaultDesignId`);
CREATE INDEX `System_defaultDesignColorId_idx` ON `System`(`defaultDesignColorId`);
CREATE INDEX `Piece_idDesign_idx` ON `Piece`(`idDesign`);
CREATE INDEX `Piece_idDesignColor_idx` ON `Piece`(`idDesignColor`);

ALTER TABLE `System` ADD CONSTRAINT `System_defaultDesignId_fkey` FOREIGN KEY (`defaultDesignId`) REFERENCES `design_patterns`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `System` ADD CONSTRAINT `System_defaultDesignColorId_fkey` FOREIGN KEY (`defaultDesignColorId`) REFERENCES `design_colors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `system_design_options` ADD CONSTRAINT `system_design_options_idSystem_fkey` FOREIGN KEY (`idSystem`) REFERENCES `System`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `system_design_options` ADD CONSTRAINT `system_design_options_idDesign_fkey` FOREIGN KEY (`idDesign`) REFERENCES `design_patterns`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `system_design_options` ADD CONSTRAINT `system_design_options_idDesignColor_fkey` FOREIGN KEY (`idDesignColor`) REFERENCES `design_colors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idDesign_fkey` FOREIGN KEY (`idDesign`) REFERENCES `design_patterns`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idDesignColor_fkey` FOREIGN KEY (`idDesignColor`) REFERENCES `design_colors`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
