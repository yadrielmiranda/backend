-- CreateTable
CREATE TABLE `sys_conf_pricing_components` (
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,
    `componentType` ENUM('DOOR', 'SIDELITE', 'TRANSOM') NOT NULL,
    `sourceConfigId` INTEGER NOT NULL,

    INDEX `idx_sys_conf_pricing_component_source`(`idSystem`, `sourceConfigId`),
    PRIMARY KEY (`idSystem`, `idConfig`, `componentType`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sys_conf_pricing_components` ADD CONSTRAINT `sys_conf_pricing_components_idSystem_idConfig_fkey` FOREIGN KEY (`idSystem`, `idConfig`) REFERENCES `sys_conf`(`idSystem`, `idConfig`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_conf_pricing_components` ADD CONSTRAINT `sys_conf_pricing_components_idSystem_sourceConfigId_fkey` FOREIGN KEY (`idSystem`, `sourceConfigId`) REFERENCES `sys_conf`(`idSystem`, `idConfig`) ON DELETE RESTRICT ON UPDATE CASCADE;
