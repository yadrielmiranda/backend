-- AlterTable
ALTER TABLE `Estimate` ADD COLUMN `agreementRevision` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `DealerContract` (
    `id` VARCHAR(36) NOT NULL,
    `dealerId` INTEGER NOT NULL,
    `version` INTEGER NOT NULL,
    `name` VARCHAR(150) NOT NULL,
    `fileKey` VARCHAR(100) NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `isCurrent` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DealerContract_dealerId_isCurrent_idx`(`dealerId`, `isCurrent`),
    INDEX `DealerContract_dealerId_sha256_idx`(`dealerId`, `sha256`),
    UNIQUE INDEX `DealerContract_dealerId_version_key`(`dealerId`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EstimateAgreement` (
    `id` VARCHAR(36) NOT NULL,
    `estimateId` INTEGER NOT NULL,
    `revision` INTEGER NOT NULL,
    `contractId` VARCHAR(36) NOT NULL,
    `pricingMode` VARCHAR(8) NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `snapshot` JSON NOT NULL,
    `quoteFileKey` VARCHAR(100) NULL,
    `quoteHash` CHAR(64) NULL,
    `receiptFileKey` VARCHAR(100) NULL,
    `receiptHash` CHAR(64) NULL,
    `signerName` VARCHAR(150) NULL,
    `signerEmail` VARCHAR(254) NULL,
    `signature` JSON NULL,
    `consentText` TEXT NULL,
    `signedAt` DATETIME(3) NULL,
    `invalidatedAt` DATETIME(3) NULL,
    `ipAddress` VARCHAR(45) NULL,
    `userAgent` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `EstimateAgreement_estimateId_pricingMode_invalidatedAt_idx`(`estimateId`, `pricingMode`, `invalidatedAt`),
    UNIQUE INDEX `EstimateAgreement_estimateId_revision_key`(`estimateId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AgreementChallenge` (
    `id` VARCHAR(36) NOT NULL,
    `agreementId` VARCHAR(36) NOT NULL,
    `codeHash` CHAR(64) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `sentAt` DATETIME(3) NULL,
    `usedAt` DATETIME(3) NULL,

    INDEX `AgreementChallenge_agreementId_createdAt_idx`(`agreementId`, `createdAt`),
    INDEX `AgreementChallenge_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DealerContract` ADD CONSTRAINT `DealerContract_dealerId_fkey` FOREIGN KEY (`dealerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EstimateAgreement` ADD CONSTRAINT `EstimateAgreement_estimateId_fkey` FOREIGN KEY (`estimateId`) REFERENCES `Estimate`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EstimateAgreement` ADD CONSTRAINT `EstimateAgreement_contractId_fkey` FOREIGN KEY (`contractId`) REFERENCES `DealerContract`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgreementChallenge` ADD CONSTRAINT `AgreementChallenge_agreementId_fkey` FOREIGN KEY (`agreementId`) REFERENCES `EstimateAgreement`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

