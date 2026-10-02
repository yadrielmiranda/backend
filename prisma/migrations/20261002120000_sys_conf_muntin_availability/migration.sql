-- Preserve the existing availability of every series/configuration.
ALTER TABLE `sys_conf`
    ADD COLUMN `muntinAvailability` ENUM('NONE', 'ALL', 'SELECTED') NOT NULL DEFAULT 'ALL';

CREATE TABLE `sys_conf_muntin_types` (
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `muntinTypeId` INTEGER NOT NULL,

    INDEX `sys_conf_muntin_types_muntinTypeId_idx` (`muntinTypeId`),
    PRIMARY KEY (`idSystem`, `idConfig`, `muntinTypeId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `sys_conf_muntin_types`
    ADD CONSTRAINT `sys_conf_muntin_types_sys_conf_fkey`
    FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf`(`idSystem`, `idConfig`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `sys_conf_muntin_types`
    ADD CONSTRAINT `sys_conf_muntin_types_muntinTypeId_fkey`
    FOREIGN KEY (`muntinTypeId`) REFERENCES `muntin_types`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
