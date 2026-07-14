-- AlterTable
ALTER TABLE `sys_conf` ADD COLUMN `sortOrder` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `System` ADD COLUMN `defaultConfigId` INTEGER NULL;

-- CreateIndex
CREATE INDEX `System_defaultConfigId_idx` ON `System`(`defaultConfigId`);

-- AddForeignKey
ALTER TABLE `System` ADD CONSTRAINT `System_defaultConfigId_fkey` FOREIGN KEY (`defaultConfigId`) REFERENCES `Config`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
