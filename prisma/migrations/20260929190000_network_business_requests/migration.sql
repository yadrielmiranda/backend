ALTER TABLE `User` ADD COLUMN `networkSuspendedByAdmin` BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE `NetworkBusinessAction` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `accountId` INTEGER NOT NULL,
    `actorId` INTEGER NULL,
    `actorName` VARCHAR(255) NOT NULL,
    `suspended` BOOLEAN NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `status` ENUM('PENDING', 'APPLIED', 'REJECTED', 'WITHDRAWN', 'SUPERSEDED') NOT NULL,
    `activeSlot` INTEGER NULL,
    `reviewedById` INTEGER NULL,
    `reviewNote` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reviewedAt` DATETIME(3) NULL,
    UNIQUE INDEX `NetworkBusinessAction_accountId_activeSlot_key`(`accountId`, `activeSlot`),
    INDEX `NetworkBusinessAction_actorId_idx`(`actorId`),
    INDEX `NetworkBusinessAction_reviewedById_idx`(`reviewedById`),
    INDEX `NetworkBusinessAction_accountId_createdAt_idx`(`accountId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `NetworkBusinessAction` ADD CONSTRAINT `NetworkBusinessAction_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `NetworkBusinessAction` ADD CONSTRAINT `NetworkBusinessAction_actorId_fkey` FOREIGN KEY (`actorId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `NetworkBusinessAction` ADD CONSTRAINT `NetworkBusinessAction_reviewedById_fkey` FOREIGN KEY (`reviewedById`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
