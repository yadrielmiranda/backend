-- AlterTable
ALTER TABLE `DealerRegistrationRequest` ADD COLUMN `promotionalSmsAccepted` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `serviceSmsAccepted` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `smsConsentText` TEXT NULL,
    ADD COLUMN `smsConsentVersion` VARCHAR(64) NULL,
    ADD COLUMN `smsConsentedAt` DATETIME(3) NULL,
    ADD COLUMN `termsAcceptedAt` DATETIME(3) NULL,
    ADD COLUMN `termsVersionId` INTEGER NULL;

-- AlterTable
ALTER TABLE `AccountWelcomeEmail` ADD COLUMN `approvalLanguage` ENUM('English', 'Spanish') NULL;

-- AlterTable
ALTER TABLE `AccountWelcomeSms` ADD COLUMN `approvalLanguage` ENUM('English', 'Spanish') NULL;

-- CreateTable
CREATE TABLE `DealerRegistrationRejectionDelivery` (
    `requestId` INTEGER NOT NULL,
    `channel` ENUM('EMAIL', 'SMS') NOT NULL,
    `destination` VARCHAR(254) NOT NULL,
    `language` ENUM('English', 'Spanish') NOT NULL,
    `smsConsentVersion` VARCHAR(64) NULL,
    `smsConsentText` TEXT NULL,
    `smsConsentedAt` DATETIME(3) NULL,
    `status` ENUM('PENDING', 'SENDING', 'ACCEPTED', 'SKIPPED', 'FAILED', 'UNKNOWN') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `attemptedAt` DATETIME(3) NULL,
    `providerMessageId` VARCHAR(320) NULL,
    `errorCode` VARCHAR(60) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `dealer_reg_rejection_delivery_queue_idx`(`channel`, `status`, `nextAttemptAt`),
    PRIMARY KEY (`requestId`, `channel`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `DealerRegistrationRequest_termsVersionId_idx` ON `DealerRegistrationRequest`(`termsVersionId`);

-- AddForeignKey
ALTER TABLE `DealerRegistrationRequest` ADD CONSTRAINT `DealerRegistrationRequest_termsVersionId_fkey` FOREIGN KEY (`termsVersionId`) REFERENCES `PlatformTermsVersion`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

