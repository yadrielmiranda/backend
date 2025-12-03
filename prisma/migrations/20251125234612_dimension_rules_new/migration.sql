/*
  Warnings:

  - You are about to drop the `dimension_rule` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE `dimension_rule` DROP FOREIGN KEY `dimension_rule_idPolicy_fkey`;

-- DropTable
DROP TABLE `dimension_rule`;

-- CreateTable
CREATE TABLE `DimensionRule` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `idPolicy` INTEGER NOT NULL,
    `widthIn` DECIMAL(65, 30) NOT NULL,
    `heightIn` DECIMAL(65, 30) NOT NULL,
    `dpPosPsf` DECIMAL(65, 30) NOT NULL,
    `dpNegPsf` DECIMAL(65, 30) NOT NULL,
    `screws` INTEGER NOT NULL,
    `note` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `idx_rule_policy_dims`(`idPolicy`, `widthIn`, `heightIn`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DimensionRule` ADD CONSTRAINT `DimensionRule_idPolicy_fkey` FOREIGN KEY (`idPolicy`) REFERENCES `dimension_policy`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
