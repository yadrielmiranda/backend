/*
  Warnings:

  - You are about to drop the `auditlog` table. If the table is not empty, all the data it contains will be lost.
  - Made the column `lastRefreshedAt` on table `session` required. This step will fail if there are existing NULL values in that column.

*/
-- DropForeignKey
ALTER TABLE `auditlog` DROP FOREIGN KEY `AuditLog_userId_fkey`;

-- AlterTable
ALTER TABLE `session` MODIFY `lastRefreshedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- DropTable
DROP TABLE `auditlog`;

-- CreateTable
CREATE TABLE `event_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `action` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL,
    `entityId` INTEGER NOT NULL,
    `userId` INTEGER NULL,
    `message` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `event_logs_userId_idx`(`userId`),
    INDEX `event_logs_entityType_idx`(`entityType`),
    INDEX `event_logs_entityId_idx`(`entityId`),
    INDEX `event_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `temp_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `eventId` INTEGER NOT NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `meta` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `temp_logs_eventId_key`(`eventId`),
    INDEX `temp_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `event_logs` ADD CONSTRAINT `event_logs_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `temp_logs` ADD CONSTRAINT `temp_logs_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `event_logs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
