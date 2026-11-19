ALTER TABLE `User`
    ADD COLUMN `companyName` VARCHAR(150) NULL,
    ADD COLUMN `estimatedMonthlySales` DECIMAL(14,2) NULL,
    ADD COLUMN `yearsOfExperience` INTEGER NULL,
    ADD COLUMN `preferredLanguage` ENUM('English', 'Spanish') NULL;

CREATE TABLE `DealerRegistrationInvite` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `scopeKey` VARCHAR(64) NOT NULL,
    `parentDealerId` INTEGER NULL,
    `token` VARCHAR(96) NOT NULL,
    `markupPercent` DECIMAL(24,16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    UNIQUE INDEX `DealerRegistrationInvite_scopeKey_key` (`scopeKey`),
    UNIQUE INDEX `DealerRegistrationInvite_token_key` (`token`),
    INDEX `DealerRegistrationInvite_parentDealerId_idx` (`parentDealerId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `DealerRegistrationInvite_parentDealerId_fkey` FOREIGN KEY (`parentDealerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `DealerRegistrationRequest` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `inviteId` INTEGER NOT NULL,
    `username` VARCHAR(24) NOT NULL,
    `email` VARCHAR(150) NOT NULL,
    `phone` VARCHAR(20) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `firstName` VARCHAR(100) NOT NULL,
    `lastName` VARCHAR(100) NOT NULL,
    `street` VARCHAR(150) NOT NULL,
    `addressLine2` VARCHAR(150) NULL,
    `city` VARCHAR(100) NOT NULL,
    `state` VARCHAR(2) NOT NULL,
    `postalCode` VARCHAR(10) NOT NULL,
    `companyName` VARCHAR(150) NULL,
    `estimatedMonthlySales` DECIMAL(14,2) NULL,
    `yearsOfExperience` INTEGER NOT NULL,
    `preferredLanguage` ENUM('English', 'Spanish') NOT NULL,
    `markupPercent` DECIMAL(24,16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE INDEX `DealerRegistrationRequest_username_key` (`username`),
    UNIQUE INDEX `DealerRegistrationRequest_email_key` (`email`),
    UNIQUE INDEX `DealerRegistrationRequest_phone_key` (`phone`),
    INDEX `DealerRegistrationRequest_inviteId_createdAt_idx` (`inviteId`, `createdAt`),
    PRIMARY KEY (`id`),
    CONSTRAINT `DealerRegistrationRequest_inviteId_fkey` FOREIGN KEY (`inviteId`) REFERENCES `DealerRegistrationInvite`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
