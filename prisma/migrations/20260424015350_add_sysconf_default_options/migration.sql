-- AlterTable
ALTER TABLE `sys_conf` ADD COLUMN `defaultActiveOptionId` INTEGER NULL,
    ADD COLUMN `defaultPreparationOptionId` INTEGER NULL,
    ADD COLUMN `defaultReinforcementOptionId` INTEGER NULL,
    ADD COLUMN `defaultSillOptionId` INTEGER NULL;

-- CreateIndex
CREATE INDEX `sys_conf_defaultActiveOptionId_idx` ON `sys_conf`(`defaultActiveOptionId`);

-- CreateIndex
CREATE INDEX `sys_conf_defaultPreparationOptionId_idx` ON `sys_conf`(`defaultPreparationOptionId`);

-- CreateIndex
CREATE INDEX `sys_conf_defaultSillOptionId_idx` ON `sys_conf`(`defaultSillOptionId`);

-- CreateIndex
CREATE INDEX `sys_conf_defaultReinforcementOptionId_idx` ON `sys_conf`(`defaultReinforcementOptionId`);

-- AddForeignKey
ALTER TABLE `sys_conf` ADD CONSTRAINT `sys_conf_defaultActiveOptionId_fkey` FOREIGN KEY (`defaultActiveOptionId`) REFERENCES `active_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_conf` ADD CONSTRAINT `sys_conf_defaultPreparationOptionId_fkey` FOREIGN KEY (`defaultPreparationOptionId`) REFERENCES `preparation_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_conf` ADD CONSTRAINT `sys_conf_defaultSillOptionId_fkey` FOREIGN KEY (`defaultSillOptionId`) REFERENCES `sill_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_conf` ADD CONSTRAINT `sys_conf_defaultReinforcementOptionId_fkey` FOREIGN KEY (`defaultReinforcementOptionId`) REFERENCES `reinforcement_options`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
