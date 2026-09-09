CREATE TABLE `NotificationEmail` (
    `notificationId` INTEGER NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `status` ENUM('PENDING', 'SENDING', 'ACCEPTED', 'SKIPPED', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `attemptedAt` DATETIME(3) NULL,
    `providerMessageId` VARCHAR(320) NULL,
    `errorCode` VARCHAR(60) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `NotificationEmail_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    PRIMARY KEY (`notificationId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `NotificationEmail` ADD CONSTRAINT `NotificationEmail_notificationId_fkey`
    FOREIGN KEY (`notificationId`) REFERENCES `Notification`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
