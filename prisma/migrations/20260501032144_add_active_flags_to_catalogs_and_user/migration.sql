/*
  Warnings:

  - You are about to drop the column `isActive` on the `brand_product` table. All the data in the column will be lost.
  - You are about to drop the column `isActive` on the `pricing_rules` table. All the data in the column will be lost.
  - You are about to drop the column `isActive` on the `sys_conf` table. All the data in the column will be lost.
  - You are about to drop the column `isActive` on the `system_crystals` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX `brand_product_isActive_idx` ON `brand_product`;

-- DropIndex
DROP INDEX `pricing_rules_isActive_idx` ON `pricing_rules`;

-- DropIndex
DROP INDEX `sys_conf_isActive_idx` ON `sys_conf`;

-- DropIndex
DROP INDEX `system_crystals_isActive_idx` ON `system_crystals`;

-- AlterTable
ALTER TABLE `brand_product` DROP COLUMN `isActive`;

-- AlterTable
ALTER TABLE `pricing_rules` DROP COLUMN `isActive`;

-- AlterTable
ALTER TABLE `sys_conf` DROP COLUMN `isActive`;

-- AlterTable
ALTER TABLE `system_crystals` DROP COLUMN `isActive`;

-- AlterTable
ALTER TABLE `user` ADD COLUMN `deletedAt` DATETIME(3) NULL,
    ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX `User_isActive_idx` ON `User`(`isActive`);

-- CreateIndex
CREATE INDEX `User_deletedAt_idx` ON `User`(`deletedAt`);
