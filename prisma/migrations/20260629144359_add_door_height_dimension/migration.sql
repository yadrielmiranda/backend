-- AlterTable
ALTER TABLE `Piece` ADD COLUMN `doorHeight` DECIMAL(10, 3) NULL;

-- AlterTable
ALTER TABLE `sys_conf` ADD COLUMN `requiresDoorHeight` BOOLEAN NOT NULL DEFAULT false;
