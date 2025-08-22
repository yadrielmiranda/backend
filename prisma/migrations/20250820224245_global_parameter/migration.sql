/*
  Warnings:

  - You are about to drop the `calculationparameter` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE `calculationparameter`;

-- CreateTable
CREATE TABLE `GlobalParameter` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` ENUM('SALES_TAX') NOT NULL,
    `value` DECIMAL(10, 4) NOT NULL,
    `description` VARCHAR(191) NULL,
    `unit` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `GlobalParameter_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
