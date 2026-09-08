CREATE TABLE `NotificationSms` (
    `notificationId` INTEGER NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `consentedAt` DATETIME(3) NOT NULL,
    `status` ENUM('PENDING', 'SENDING', 'ACCEPTED', 'SKIPPED', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `attemptedAt` DATETIME(3) NULL,
    `providerMessageSid` VARCHAR(34) NULL,
    `errorCode` VARCHAR(60) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `NotificationSms_providerMessageSid_key`(`providerMessageSid`),
    INDEX `NotificationSms_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    PRIMARY KEY (`notificationId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `NotificationSms` ADD CONSTRAINT `NotificationSms_notificationId_fkey`
    FOREIGN KEY (`notificationId`) REFERENCES `Notification`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
