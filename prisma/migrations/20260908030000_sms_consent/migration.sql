-- Sin autorizaciones iniciales: cada usuario debe aceptar expresamente.
CREATE TABLE `SmsConsent` (
    `userId` INTEGER NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `consentVersion` VARCHAR(64) NULL,
    `consentText` TEXT NULL,
    `consentedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    INDEX `SmsConsent_phone_idx` (`phone`),
    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SmsConsentEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NULL,
    `phone` VARCHAR(20) NOT NULL,
    `action` ENUM('OPT_IN', 'OPT_OUT', 'PHONE_CHANGED', 'ACCOUNT_DISABLED', 'PROVIDER_STOP', 'PROVIDER_START') NOT NULL,
    `consentVersion` VARCHAR(64) NULL,
    `consentText` TEXT NULL,
    `providerMessageSid` VARCHAR(34) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `SmsConsentEvent_providerMessageSid_key` (`providerMessageSid`),
    INDEX `SmsConsentEvent_userId_createdAt_idx` (`userId`, `createdAt`),
    INDEX `SmsConsentEvent_phone_createdAt_idx` (`phone`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `SmsPhoneBlock` (
    `phone` VARCHAR(20) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`phone`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `SmsConsent` ADD CONSTRAINT `SmsConsent_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `SmsConsentEvent` ADD CONSTRAINT `SmsConsentEvent_userId_fkey`
    FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
