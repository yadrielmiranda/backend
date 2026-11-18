-- Empty outbox: existing accounts and consent records are not backfilled.
CREATE TABLE `AccountWelcomeSms` (
    `userId` INTEGER NOT NULL,
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
    PRIMARY KEY (`userId`),
    UNIQUE INDEX `AccountWelcomeSms_providerMessageSid_key` (`providerMessageSid`),
    INDEX `AccountWelcomeSms_status_nextAttemptAt_idx` (`status`, `nextAttemptAt`),
    CONSTRAINT `AccountWelcomeSms_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
