/*
  Warnings:

  - You are about to drop the column `active` on the `estimate` table. All the data in the column will be lost.
  - Added the required column `statusId` to the `Estimate` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `estimate` DROP COLUMN `active`,
    ADD COLUMN `statusId` INTEGER NOT NULL;

-- CreateTable
CREATE TABLE `EstimateStatus` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `EstimateStatus_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Estimate` ADD CONSTRAINT `Estimate_statusId_fkey` FOREIGN KEY (`statusId`) REFERENCES `EstimateStatus`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
