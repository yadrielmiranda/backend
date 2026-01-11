/*
  Warnings:

  - A unique constraint covering the columns `[poNumber]` on the table `Order` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `netProfit` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `price` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `rate` to the `Order` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `order` ADD COLUMN `netProfit` DECIMAL(12, 2) NOT NULL,
    ADD COLUMN `netProfitReal` DECIMAL(12, 2) NULL,
    ADD COLUMN `poNumber` VARCHAR(50) NULL,
    ADD COLUMN `price` DECIMAL(12, 2) NOT NULL,
    ADD COLUMN `rate` DECIMAL(12, 2) NOT NULL,
    ADD COLUMN `rateReal` DECIMAL(12, 2) NULL;

-- AlterTable
ALTER TABLE `session` MODIFY `lastRefreshedAt` DATETIME(3) NULL DEFAULT CURRENT_TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX `Order_poNumber_key` ON `Order`(`poNumber`);

-- CreateIndex
CREATE INDEX `Order_date_idx` ON `Order`(`date`);

-- RenameIndex
ALTER TABLE `order` RENAME INDEX `Order_statusId_fkey` TO `Order_statusId_idx`;

-- RenameIndex
ALTER TABLE `order` RENAME INDEX `Order_userId_fkey` TO `Order_userId_idx`;
