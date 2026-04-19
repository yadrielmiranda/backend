-- AlterTable
ALTER TABLE `piece` ADD COLUMN `idActiveOption` INTEGER NULL,
    ADD COLUMN `idPreparationOption` INTEGER NULL,
    ADD COLUMN `idReinforcementOption` INTEGER NULL,
    ADD COLUMN `idSillOption` INTEGER NULL;

-- CreateTable
CREATE TABLE `active_options` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `active_options_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preparation_options` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(150) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `preparation_options_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sill_options` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sill_options_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reinforcement_options` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `reinforcement_options_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sysconf_active_options` (
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `optionId` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `sysconf_active_options_optionId_idx`(`optionId`),
    PRIMARY KEY (`idSystem`, `idConfig`, `optionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sysconf_preparation_options` (
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `optionId` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `sysconf_preparation_options_optionId_idx`(`optionId`),
    PRIMARY KEY (`idSystem`, `idConfig`, `optionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sysconf_sill_options` (
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `optionId` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `sysconf_sill_options_optionId_idx`(`optionId`),
    PRIMARY KEY (`idSystem`, `idConfig`, `optionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sysconf_reinforcement_options` (
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `optionId` INTEGER NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `sysconf_reinforcement_options_optionId_idx`(`optionId`),
    PRIMARY KEY (`idSystem`, `idConfig`, `optionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Piece_idActiveOption_idx` ON `Piece`(`idActiveOption`);

-- CreateIndex
CREATE INDEX `Piece_idPreparationOption_idx` ON `Piece`(`idPreparationOption`);

-- CreateIndex
CREATE INDEX `Piece_idSillOption_idx` ON `Piece`(`idSillOption`);

-- CreateIndex
CREATE INDEX `Piece_idReinforcementOption_idx` ON `Piece`(`idReinforcementOption`);

-- AddForeignKey
ALTER TABLE `sysconf_active_options` ADD CONSTRAINT `sysconf_active_options_idSystem_idConfig_fkey` FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf`(`idSystem`, `idConfig`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_active_options` ADD CONSTRAINT `sysconf_active_options_optionId_fkey` FOREIGN KEY (`optionId`) REFERENCES `active_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_preparation_options` ADD CONSTRAINT `sysconf_preparation_options_idSystem_idConfig_fkey` FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf`(`idSystem`, `idConfig`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_preparation_options` ADD CONSTRAINT `sysconf_preparation_options_optionId_fkey` FOREIGN KEY (`optionId`) REFERENCES `preparation_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_sill_options` ADD CONSTRAINT `sysconf_sill_options_idSystem_idConfig_fkey` FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf`(`idSystem`, `idConfig`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_sill_options` ADD CONSTRAINT `sysconf_sill_options_optionId_fkey` FOREIGN KEY (`optionId`) REFERENCES `sill_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_reinforcement_options` ADD CONSTRAINT `sysconf_reinforcement_options_idSystem_idConfig_fkey` FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf`(`idSystem`, `idConfig`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sysconf_reinforcement_options` ADD CONSTRAINT `sysconf_reinforcement_options_optionId_fkey` FOREIGN KEY (`optionId`) REFERENCES `reinforcement_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idActiveOption_fkey` FOREIGN KEY (`idActiveOption`) REFERENCES `active_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idPreparationOption_fkey` FOREIGN KEY (`idPreparationOption`) REFERENCES `preparation_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idSillOption_fkey` FOREIGN KEY (`idSillOption`) REFERENCES `sill_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Piece` ADD CONSTRAINT `Piece_idReinforcementOption_fkey` FOREIGN KEY (`idReinforcementOption`) REFERENCES `reinforcement_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
