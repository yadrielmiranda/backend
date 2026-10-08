-- CreateTable
CREATE TABLE `ReferralProfile` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `userId` INTEGER NOT NULL,
    `code` VARCHAR(40) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `mode` ENUM('EXTERNAL_MARGIN', 'CUSTOM_PERCENT', 'DEALER_PLAN') NOT NULL DEFAULT 'CUSTOM_PERCENT',
    `percent` DECIMAL(7, 4) NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `linkCreatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReferralProfile_userId_key`(`userId`),
    UNIQUE INDEX `ReferralProfile_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReferralAttribution` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `profileId` INTEGER NOT NULL,
    `referredUserId` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ReferralAttribution_referredUserId_key`(`referredUserId`),
    INDEX `ReferralAttribution_profileId_createdAt_idx`(`profileId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReferralReward` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `profileId` INTEGER NOT NULL,
    `attributionId` INTEGER NOT NULL,
    `orderId` INTEGER NOT NULL,
    `terms` JSON NOT NULL,
    `earnedAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `availableAmount` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `reason` VARCHAR(60) NOT NULL DEFAULT 'PENDING_PAYMENT',
    `evaluatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ReferralReward_orderId_key`(`orderId`),
    INDEX `ReferralReward_profileId_createdAt_idx`(`profileId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReferralLedgerEntry` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `rewardId` INTEGER NOT NULL,
    `earnedDelta` DECIMAL(18, 2) NOT NULL,
    `availableDelta` DECIMAL(18, 2) NOT NULL,
    `reason` VARCHAR(60) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReferralLedgerEntry_rewardId_createdAt_idx`(`rewardId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReferralBankAccount` (
    `profileId` INTEGER NOT NULL,
    `encryptedDetails` TEXT NOT NULL,
    `accountLast4` VARCHAR(4) NOT NULL,
    `bankName` VARCHAR(100) NOT NULL,
    `accountType` ENUM('CHECKING', 'SAVINGS') NOT NULL,
    `holderType` ENUM('PERSONAL', 'BUSINESS') NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`profileId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReferralPayout` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `profileId` INTEGER NOT NULL,
    `requestKey` VARCHAR(36) NOT NULL,
    `amount` DECIMAL(18, 2) NOT NULL,
    `status` ENUM('REQUESTED', 'PROCESSING', 'PAID', 'REJECTED', 'FAILED', 'CANCELED') NOT NULL DEFAULT 'REQUESTED',
    `encryptedDestination` TEXT NOT NULL,
    `accountLast4` VARCHAR(4) NOT NULL,
    `bankName` VARCHAR(100) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `processingAt` DATETIME(3) NULL,
    `processingById` INTEGER NULL,
    `paidAt` DATETIME(3) NULL,
    `reference` VARCHAR(150) NULL,
    `proofReference` VARCHAR(300) NULL,
    `bankFee` DECIMAL(18, 2) NOT NULL DEFAULT 0,

    UNIQUE INDEX `ReferralPayout_requestKey_key`(`requestKey`),
    INDEX `ReferralPayout_profileId_createdAt_idx`(`profileId`, `createdAt`),
    INDEX `ReferralPayout_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReferralPayoutEvent` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `payoutId` INTEGER NOT NULL,
    `actorId` INTEGER NOT NULL,
    `status` ENUM('REQUESTED', 'PROCESSING', 'PAID', 'REJECTED', 'FAILED', 'CANCELED') NOT NULL,
    `note` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReferralPayoutEvent_payoutId_createdAt_idx`(`payoutId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReferralSettings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `minimumWithdrawal` DECIMAL(18, 2) NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ReferralProfile` ADD CONSTRAINT `ReferralProfile_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReferralAttribution` ADD CONSTRAINT `ReferralAttribution_profileId_fkey` FOREIGN KEY (`profileId`) REFERENCES `ReferralProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReferralAttribution` ADD CONSTRAINT `ReferralAttribution_referredUserId_fkey` FOREIGN KEY (`referredUserId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReferralReward` ADD CONSTRAINT `ReferralReward_profileId_fkey` FOREIGN KEY (`profileId`) REFERENCES `ReferralProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReferralReward` ADD CONSTRAINT `ReferralReward_attributionId_fkey` FOREIGN KEY (`attributionId`) REFERENCES `ReferralAttribution`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReferralReward` ADD CONSTRAINT `ReferralReward_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReferralLedgerEntry` ADD CONSTRAINT `ReferralLedgerEntry_rewardId_fkey` FOREIGN KEY (`rewardId`) REFERENCES `ReferralReward`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReferralBankAccount` ADD CONSTRAINT `ReferralBankAccount_profileId_fkey` FOREIGN KEY (`profileId`) REFERENCES `ReferralProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReferralPayout` ADD CONSTRAINT `ReferralPayout_profileId_fkey` FOREIGN KEY (`profileId`) REFERENCES `ReferralProfile`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReferralPayoutEvent` ADD CONSTRAINT `ReferralPayoutEvent_payoutId_fkey` FOREIGN KEY (`payoutId`) REFERENCES `ReferralPayout`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
