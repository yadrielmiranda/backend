-- Technician contact addresses are deliberately independent of unique login emails.
ALTER TABLE `User` ADD COLUMN `contactEmail` VARCHAR(254) NULL;

-- Only future account creations enqueue a welcome; no historical users are inserted.
CREATE TABLE `AccountWelcomeEmail` (
    `userId` INTEGER NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `status` ENUM('PENDING', 'SENDING', 'ACCEPTED', 'SKIPPED', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `attemptedAt` DATETIME(3) NULL,
    `providerMessageId` VARCHAR(320) NULL,
    `errorCode` VARCHAR(60) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`userId`),
    INDEX `AccountWelcomeEmail_status_nextAttemptAt_idx` (`status`, `nextAttemptAt`),
    CONSTRAINT `AccountWelcomeEmail_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
