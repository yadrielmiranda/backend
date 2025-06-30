/*
  Warnings:

  - You are about to drop the `sysconf` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `sysconf` DROP FOREIGN KEY `SysConf_idConf_fkey`;

-- DropForeignKey
ALTER TABLE `sysconf` DROP FOREIGN KEY `SysConf_idSys_fkey`;

-- DropTable
DROP TABLE `sysconf`;

-- CreateTable
CREATE TABLE `sys_conf` (
    `idSystem` INTEGER NOT NULL,
    `idConfig` INTEGER NOT NULL,

    PRIMARY KEY (`idSystem`, `idConfig`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sys_conf` ADD CONSTRAINT `sys_conf_idSystem_fkey` FOREIGN KEY (`idSystem`) REFERENCES `System`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sys_conf` ADD CONSTRAINT `sys_conf_idConfig_fkey` FOREIGN KEY (`idConfig`) REFERENCES `Config`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
